// red-first-check — verify a branch's red commit and what became of its tests.
//
//   node scripts/workflow/red-first-check.ts <red-commit> [<branch>] [--package <dir>] [--repo <dir>]
//
// The development lifecycle (docs/harness-workflow.md, ADR LEG-2026-068) has the
// builder commit failing tests alone, then implement. Given that red commit
// and the branch it sits on (default HEAD), this checks four things:
//
//   1. scope      the red commit adds or modifies only test files (*.test.ts,
//                 *.test.tsx) and test fixtures (anything under a testdata/,
//                 fixtures/, __fixtures__/ or __snapshots__/ directory). It
//                 deletes nothing, and adds at least one runnable test file.
//   2. red        each runnable test file the red commit touches fails when
//                 the package's test command (`npm test`, which is vitest run)
//                 runs at the red commit, scoped to those files, in a
//                 temporary worktree with the package's installed
//                 dependencies linked in. A file fails if any of its tests
//                 fails or it does not load. A new case that passes inside a
//                 failing file is reported as a note, not a failure.
//   3. preserved  at the branch head, none of the red commit's test cases (the
//                 cases it added or changed) is deleted, skipped, emptied, or
//                 left with fewer assertions. A file renamed after the red
//                 commit is followed through git's rename detection.
//   4. head       the same test command, run at the branch head in a
//                 temporary worktree on those files (at their head paths),
//                 collects every red case, runs it, sees it pass, and sees it
//                 make at least one assertion. The run uses the package's own
//                 vitest configuration plus a setup file that records each
//                 case's assertion count (vitest's expect.getState()). So a
//                 file renamed out of the runner's reach or excluded in its
//                 configuration, ctx.skip(), an early return or assertions
//                 behind a false condition all fail. Titles written with
//                 each-placeholders (%s, $name) or as templates or expressions
//                 match any reported title in that position.
//
// Exit status: 0 all checks pass, 1 a check failed, 2 usage or environment
// error (no such commit, red commit not on the branch, test run produced no
// report).
//
// How test cases are compared (check 3), and the limits of that comparison.
// Files are parsed with the TypeScript compiler; nothing is executed. It
// COUNTS assertions and never reads them: expect(1).toBe(1) counts the same
// as the assertion it replaced, and the head run (check 4) only shows that
// some assertion ran. Whoever reviews must read every "changed" note. A case is a call
// to test(...) or it(...), with any modifier chain (test.skip, it.each(...),
// test.skipIf(c)), identified by its file, the titles of the describe/suite
// blocks around it and its own title, as written in the source (a template
// title is its source text). Repeated identities get " #2", " #3" by order.
//   · A case is skipped if it, or a describe around it, uses skip, todo,
//     skipIf, runIf or fails, or if a .only elsewhere in the file excludes it.
//   · A case is emptied if its callback has no statements, or it has none.
//   · An assertion is one complete expect(...).<matcher>(...) chain (also
//     expect.soft/poll and expectTypeOf), an assert(...) or assert.<fn>(...)
//     call, assertType(...), or expect.assertions/hasAssertions(...). A bare
//     expect(x) is not one. Only calls written inside the case's own callback
//     count: assertions inside helper functions it calls are invisible, so
//     moving assertions into a helper reads as removing them.
//   · Not detected: a changed matcher or expected value (toBe(3) becoming
//     toBeDefined()), a replaced or tautological assertion, an assertion
//     skipped on one path while another still runs, a case moved to another
//     file or retitled (reported as deleted), cases generated in loops or
//     from helper-defined suites. Concurrent tests share vitest's assertion
//     counter, so their counts in check 4 are approximate. Cases whose text
//     changed in any way are listed as notes for the reviewer to read.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
// Repository scripts have no package of their own: the compiler comes from the
// harness package's installed dependencies, which `npm ci` in agent/ provides.
import ts from "../../agent/node_modules/typescript/lib/typescript.js";

const USAGE = "usage: node scripts/workflow/red-first-check.ts <red-commit> [<branch>] [--package <dir>] [--repo <dir>]";

// ---------------------------------------------------------------------------
// Paths

const FIXTURE_SEGMENTS = new Set(["testdata", "fixtures", "__fixtures__", "__snapshots__"]);
const TEST_FILE = /\.test\.tsx?$/;

function underFixtureDirectory(path: string): boolean {
  return path.split("/").slice(0, -1).some((segment) => FIXTURE_SEGMENTS.has(segment));
}

/** A path a red commit may touch: a test file or a test fixture. */
export function isTestPath(path: string): boolean {
  return TEST_FILE.test(path) || underFixtureDirectory(path);
}

/** A test file the test command runs: a test file outside fixture directories. */
export function isRunnableTestPath(path: string): boolean {
  return TEST_FILE.test(path) && !underFixtureDirectory(path);
}

// ---------------------------------------------------------------------------
// Test cases

export interface TestCase {
  /** Describe titles and the case title, joined with " > ". */
  readonly id: string;
  readonly titles: readonly string[];
  readonly line: number;
  readonly skipped: boolean;
  readonly statements: number;
  readonly assertions: number;
  /** The case's source with whitespace collapsed, for change detection. */
  readonly text: string;
}

const CASE_ROOTS = new Set(["test", "it"]);
const GROUP_ROOTS = new Set(["describe", "suite"]);
const SKIPPING = new Set(["skip", "todo", "skipIf", "runIf", "fails"]);

/** The root identifier and modifier names of a callee like `it.skipIf(c)` or `test.each([...])`. */
function calleeChain(callee: ts.Expression): { root: string; modifiers: string[] } | undefined {
  const modifiers: string[] = [];
  let node: ts.Expression = callee;
  for (;;) {
    if (ts.isIdentifier(node)) return { root: node.text, modifiers: modifiers.reverse() };
    if (ts.isPropertyAccessExpression(node)) { modifiers.push(node.name.text); node = node.expression; continue; }
    if (ts.isCallExpression(node)) { node = node.expression; continue; }
    return undefined;
  }
}

function titleOf(node: ts.Expression | undefined, file: ts.SourceFile): string {
  if (node === undefined) return "";
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText(file);
  // Any other expression (a constant, a call) is written as a template of it,
  // so the head run matches it to whatever title it produced.
  return `\`\${${node.getText(file)}}\``;
}

function callbackOf(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  return call.arguments.slice(1).find((a): a is ts.ArrowFunction | ts.FunctionExpression =>
    ts.isArrowFunction(a) || ts.isFunctionExpression(a));
}

function statementCount(fn: ts.ArrowFunction | ts.FunctionExpression | undefined): number {
  if (fn === undefined) return 0;
  return ts.isBlock(fn.body) ? fn.body.statements.length : 1;
}

const EXPECT_ROOTS = new Set(["expect", "expectTypeOf"]);
const ASSERT_ROOTS = new Set(["assert", "assertType"]);

/** Whether a call `expect(...)` is continued by a matcher call further up its chain. */
function hasMatcherCall(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  for (;;) {
    const parent: ts.Node = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) { node = parent; continue; }
    if (ts.isCallExpression(parent) && parent.expression === node) return true;
    return false;
  }
}

function countAssertions(root: ts.Node | undefined): number {
  if (root === undefined) return 0;
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (ASSERT_ROOTS.has(callee.text)) count++;
        else if (EXPECT_ROOTS.has(callee.text) && hasMatcherCall(node)) count++;
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const owner = callee.expression.text;
        const name = callee.name.text;
        if (ASSERT_ROOTS.has(owner)) count++;
        else if (owner === "expect" && (name === "assertions" || name === "hasAssertions")) count++;
        else if (owner === "expect" && hasMatcherCall(node)) count++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return count;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Every test case in a test file's source, in source order. */
export function extractTestCases(source: string, fileName = "file.test.ts"): TestCase[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  interface Raw { titles: string[]; line: number; skipped: boolean; underOnly: boolean; statements: number; assertions: number; text: string }
  const raw: Raw[] = [];
  let fileHasOnly = false;

  const visit = (node: ts.Node, titles: string[], skipped: boolean, underOnly: boolean): void => {
    if (ts.isCallExpression(node)) {
      const chain = calleeChain(node.expression);
      if (chain !== undefined && (CASE_ROOTS.has(chain.root) || GROUP_ROOTS.has(chain.root))) {
        const skips = skipped || chain.modifiers.some((m) => SKIPPING.has(m));
        const only = chain.modifiers.includes("only");
        if (only) fileHasOnly = true;
        const path = [...titles, titleOf(node.arguments[0], file)];
        const callback = callbackOf(node);
        if (CASE_ROOTS.has(chain.root)) {
          raw.push({
            titles: path, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            skipped: skips || chain.modifiers.includes("todo"), underOnly: underOnly || only,
            statements: statementCount(callback), assertions: countAssertions(callback?.body), text: collapse(node.getText(file)),
          });
          return;
        }
        if (callback !== undefined) ts.forEachChild(callback.body, (child) => visit(child, path, skips, underOnly || only));
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, titles, skipped, underOnly));
  };
  visit(file, [], false, false);

  const seen = new Map<string, number>();
  return raw.map((r) => {
    const base = r.titles.join(" > ");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      id: n === 1 ? base : `${base} #${n}`, titles: r.titles, line: r.line,
      skipped: r.skipped || (fileHasOnly && !r.underOnly), statements: r.statements, assertions: r.assertions, text: r.text,
    };
  });
}

/** The cases a commit added or changed in one file, given the file before (undefined if new) and after. */
export function redCases(before: string | undefined, after: string, fileName?: string): TestCase[] {
  const cases = extractTestCases(after, fileName);
  if (before === undefined) return cases;
  const prior = new Map(extractTestCases(before, fileName).map((c) => [c.id, c.text]));
  return cases.filter((c) => prior.get(c.id) !== c.text);
}

export type WeakeningKind = "deleted" | "skipped" | "emptied" | "assertions-removed";
export interface Weakening { readonly id: string; readonly kind: WeakeningKind; readonly detail: string }

/** How the red commit's cases were weakened at the head; head undefined means the file is gone. */
export function compareCases(red: readonly TestCase[], head: readonly TestCase[] | undefined): Weakening[] {
  const now = new Map((head ?? []).map((c) => [c.id, c]));
  const found: Weakening[] = [];
  for (const before of red) {
    const after = now.get(before.id);
    if (after === undefined) {
      found.push({ id: before.id, kind: "deleted", detail: head === undefined ? "its file no longer exists" : "no case with this title" });
      continue;
    }
    if (after.skipped && !before.skipped) found.push({ id: before.id, kind: "skipped", detail: "skipped, conditional, todo or expected to fail" });
    if (after.statements === 0 && before.statements > 0) {
      found.push({ id: before.id, kind: "emptied", detail: `body went from ${before.statements} statements to none` });
    } else if (after.assertions < before.assertions) {
      found.push({ id: before.id, kind: "assertions-removed", detail: `assertions went from ${before.assertions} to ${after.assertions}` });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Git

class UsageError extends Error {}

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new UsageError(`git ${args.join(" ")}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function show(repo: string, commit: string, path: string): string | undefined {
  const result = spawnSync("git", ["show", `${commit}:${path}`], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}

interface Change { readonly status: string; readonly path: string; readonly from?: string }

function parseNameStatus(output: string): Change[] {
  return output.split("\n").filter((l) => l !== "").map((line) => {
    const [status = "", first = "", second] = line.split("\t");
    return second === undefined ? { status: status[0] ?? "", path: first } : { status: status[0] ?? "", path: second, from: first };
  });
}

function resolveCommit(repo: string, ref: string): string {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new UsageError(`no such commit: ${ref}`);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// The check

interface VitestReport {
  testResults?: { name: string; status: string; message?: string; assertionResults?: { ancestorTitles: string[]; title: string; status: string }[] }[];
}

type FileResult = NonNullable<VitestReport["testResults"]>[number];
/** One case's run-time record from the counting setup file: its titles and how many assertions it made. */
interface Counted { readonly file: string; readonly titles: readonly string[]; readonly assertions: number }

const CONFIG_NAMES = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs"];

// Loaded by the head run's configuration: after each case, records its titles
// and the assertions it made (vitest's own per-test count, which expect.assertions uses).
const COUNTING_SETUP = `import { afterEach, expect } from "vitest";
import { appendFileSync } from "node:fs";
afterEach((context) => {
  const titles = [];
  for (let task = context.task; task !== undefined && task !== context.task.file; task = task.suite) titles.unshift(task.name);
  appendFileSync(process.env.RED_FIRST_COUNTS, JSON.stringify({ file: context.task.file.filepath, titles, assertions: expect.getState().assertionCalls }) + "\\n");
});
`;

/**
 * Run the package's test command at a commit, in a temporary worktree, scoped
 * to the given repository-relative files. With counting, the run's
 * configuration is the package's own plus a setup file that records each
 * case's assertions. Returns the run's results by repository-relative path.
 */
function runTests(repo: string, commit: string, pkg: string, files: readonly string[], counting: boolean):
  { results: Map<string, FileResult>; counts: Counted[] } {
  const installed = join(repo, pkg, "node_modules");
  if (!existsSync(installed)) throw new UsageError(`${relative(repo, installed)} is missing: run npm ci in ${pkg}/ first`);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "red-first-check-")));
  const tree = join(scratch, "tree");
  const report = join(scratch, "report.json");
  const countsFile = join(scratch, "counts.jsonl");
  git(repo, "worktree", "add", "--detach", "--quiet", tree, commit);
  try {
    const packageDir = join(tree, pkg);
    // A red commit that tracks node_modules itself fails the scope check; the
    // run still uses what the commit provides rather than failing to link.
    const linked = join(packageDir, "node_modules");
    if (lstatSync(linked, { throwIfNoEntry: false }) === undefined) symlinkSync(realpathSync(installed), linked, "dir");
    const extra: string[] = ["--passWithNoTests"];
    if (counting) {
      writeFileSync(join(packageDir, "red-first-check.setup.mjs"), COUNTING_SETUP);
      const own = CONFIG_NAMES.find((name) => existsSync(join(packageDir, name)));
      const config = join(packageDir, "red-first-check.vitest.config.mjs");
      writeFileSync(config, own === undefined
        ? 'export default { test: { setupFiles: ["./red-first-check.setup.mjs"] } };\n'
        : `import { mergeConfig } from "vitest/config";\nimport own from "./${own}";\n` +
          'export default mergeConfig(own, { test: { setupFiles: ["./red-first-check.setup.mjs"] } });\n');
      extra.push(`--config=${config}`);
    }
    const scoped = files.map((f) => relative(pkg, f));
    const run = spawnSync("npm", ["test", "--silent", "--", "--reporter=json", `--outputFile=${report}`, ...extra, ...scoped], {
      cwd: packageDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1", RED_FIRST_COUNTS: countsFile },
    });
    if (!existsSync(report)) {
      throw new UsageError(`the test command wrote no report (exit ${run.status}):\n${(run.stderr || run.stdout).trim().slice(-2000)}`);
    }
    const results = new Map<string, FileResult>();
    for (const result of (JSON.parse(readFileSync(report, "utf8")) as VitestReport).testResults ?? []) {
      results.set(relative(tree, resolve(result.name)), result);
    }
    const counts = !existsSync(countsFile) ? [] : readFileSync(countsFile, "utf8").split("\n").filter((l) => l !== "")
      .map((line) => JSON.parse(line) as Counted).map((c) => ({ ...c, file: relative(tree, resolve(c.file)) }));
    return { results, counts };
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: repo });
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A title as written becomes a pattern for the titles the runner reports (each/template placeholders match anything). */
function titlePattern(title: string): RegExp {
  const source = title.startsWith("`") && title.endsWith("`") && title.length >= 2 ? title.slice(1, -1) : title;
  const parts = source.split(/(%[sdifjoOc#]|\$\{[^}]*\}|\$[\w.]+)/);
  return new RegExp(`^${parts.map((part, i) => (i % 2 === 1 ? ".*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`, "s");
}

function matchesTitles(patterns: readonly RegExp[], titles: readonly string[]): boolean {
  return patterns.length === titles.length && patterns.every((p, i) => p.test(titles[i] ?? ""));
}

/** At the head, every red case must be collected, executed, passing, and must make at least one assertion. */
function checkAtHead(repo: string, head: string, pkg: string, owned: ReadonlyMap<string, { cases: TestCase[] }>, print: (line: string) => void): string[] {
  const files = [...owned.keys()];
  if (files.length === 0) return [];
  print(`head: running npm test at ${head.slice(0, 12)} on ${files.length} file(s)`);
  const { results, counts } = runTests(repo, head, pkg, files, true);
  const failures: string[] = [];
  for (const [file, { cases }] of owned) {
    const result = results.get(file);
    if (result === undefined) {
      failures.push(`${file}: the test command does not collect it at the head, so none of its ${cases.length} red case(s) runs`);
      continue;
    }
    const reported = result.assertionResults ?? [];
    for (const c of cases) {
      const patterns = c.titles.map(titlePattern);
      const runs = reported.filter((r) => matchesTitles(patterns, [...r.ancestorTitles, r.title]));
      if (runs.length === 0) { failures.push(`${file}: "${c.id}" was not run at the head`); continue; }
      const statuses = [...new Set(runs.map((r) => r.status).filter((s) => s !== "passed"))];
      if (statuses.length > 0) { failures.push(`${file}: "${c.id}" ${statuses.join(", ")} at the head`); continue; }
      const made = counts.filter((n) => n.file === file && matchesTitles(patterns, n.titles));
      if (made.length === 0 || made.some((n) => n.assertions === 0)) {
        failures.push(`${file}: "${c.id}" passed with no assertions at the head`);
      }
    }
  }
  return failures;
}

function runAtRed(repo: string, red: string, pkg: string, files: readonly string[], print: (line: string) => void): { failures: string[]; notes: string[] } {
  print(`red: running npm test at ${red.slice(0, 12)} on ${files.length} file(s)`);
  const { results } = runTests(repo, red, pkg, files, false);
  {
    const failures: string[] = [];
    const notes: string[] = [];
    for (const file of files) {
      const result = results.get(file);
      if (result === undefined) { failures.push(`${file}: the test command did not collect it at the red commit`); continue; }
      const cases = result.assertionResults ?? [];
      const passed = cases.filter((c) => c.status === "passed").length;
      if (result.status !== "failed") {
        failures.push(`${file}: every test passes at the red commit (${passed} passed); a red test must fail before the build`);
        continue;
      }
      const failed = cases.filter((c) => c.status === "failed").length;
      print(`red: ${file} fails at the red commit (${cases.length === 0 ? "does not load" : `${failed} failed, ${passed} passed`})`);
      const before = show(repo, `${red}^`, file);
      const owned = new Set(redCases(before, show(repo, red, file) ?? "", file).map((c) => c.titles.join(" > ")));
      for (const c of cases) {
        const id = [...c.ancestorTitles, c.title].join(" > ");
        if (c.status === "passed" && owned.has(id)) notes.push(`${file}: new case "${id}" already passes at the red commit`);
      }
    }
    return { failures, notes };
  }
}

function headPathOf(repo: string, red: string, head: string, path: string): string | undefined {
  const changes = parseNameStatus(git(repo, "diff", "--name-status", "-M", red, head));
  const change = changes.find((c) => (c.from ?? c.path) === path);
  if (change === undefined) return path;
  if (change.status === "D") return undefined;
  return change.path;
}

function run(args: readonly string[], print: (line: string) => void): number {
  const positional: string[] = [];
  let repoArg: string | undefined;
  let pkg = "agent";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--repo" || arg === "--package") {
      const value = args[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      if (arg === "--repo") repoArg = value; else pkg = value.replace(/\/+$/, "");
    } else if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2) throw new UsageError("name the red commit, and optionally the branch");
  const repo = git(repoArg ?? process.cwd(), "rev-parse", "--show-toplevel").trim();
  const red = resolveCommit(repo, positional[0] ?? "");
  const head = resolveCommit(repo, positional[1] ?? "HEAD");
  const parents = git(repo, "rev-list", "--parents", "-n", "1", red).trim().split(" ").slice(1);
  if (parents.length !== 1) throw new UsageError(`the red commit must have exactly one parent (it has ${parents.length})`);
  if (spawnSync("git", ["merge-base", "--is-ancestor", red, head], { cwd: repo }).status !== 0) {
    throw new UsageError(`${positional[0]} is not on ${positional[1] ?? "HEAD"}`);
  }

  const failures: string[] = [];
  const notes: string[] = [];

  // 1. scope
  const changes = parseNameStatus(git(repo, "diff-tree", "-r", "--no-commit-id", "--name-status", "-M", `${red}^`, red));
  for (const change of changes) {
    if (change.status === "D") failures.push(`scope: the red commit deletes ${change.path}`);
    else if (!isTestPath(change.path)) failures.push(`scope: ${change.path} is not a test file or test fixture`);
    else if (change.from !== undefined && !isTestPath(change.from)) failures.push(`scope: ${change.path} was moved from ${change.from}, which is not a test path`);
  }
  const testFiles = changes.filter((c) => c.status !== "D" && isRunnableTestPath(c.path)).map((c) => c.path);
  if (testFiles.length === 0) failures.push("scope: the red commit adds or changes no runnable test file");
  const outside = testFiles.filter((f) => !f.startsWith(`${pkg}/`));
  for (const file of outside) failures.push(`scope: ${file} is outside the package ${pkg}/, whose test command runs the tests`);
  print(`scope: ${changes.length} path(s) in the red commit, ${testFiles.length} runnable test file(s)`);

  // 2. red
  const runnable = testFiles.filter((f) => f.startsWith(`${pkg}/`));
  if (runnable.length > 0) {
    const result = runAtRed(repo, red, pkg, runnable, print);
    failures.push(...result.failures.map((f) => `red: ${f}`));
    notes.push(...result.notes);
  }

  // 3. preserved
  let owned = 0;
  const atHead = new Map<string, { cases: TestCase[] }>();
  for (const file of testFiles) {
    const cases = redCases(show(repo, `${red}^`, file), show(repo, red, file) ?? "", file);
    owned += cases.length;
    const at = headPathOf(repo, red, head, file);
    if (at !== undefined && cases.length > 0 && file.startsWith(`${pkg}/`)) {
      atHead.set(at, { cases: [...(atHead.get(at)?.cases ?? []), ...cases] });
    }
    const source = at === undefined ? undefined : show(repo, head, at);
    const headCases = source === undefined ? undefined : extractTestCases(source, at);
    for (const w of compareCases(cases, headCases)) failures.push(`preserved: ${file}: "${w.id}" ${w.kind} (${w.detail})`);
    const now = new Map((headCases ?? []).map((c) => [c.id, c.text]));
    for (const c of cases) {
      const text = now.get(c.id);
      if (text !== undefined && text !== c.text) notes.push(`${at ?? file}: "${c.id}" changed since the red commit; read the change`);
    }
  }
  print(`preserved: ${owned} test case(s) from the red commit compared at ${head.slice(0, 12)}`);

  // 4. head
  failures.push(...checkAtHead(repo, head, pkg, atHead, print).map((f) => `head: ${f}`));

  for (const note of notes) print(`note: ${note}`);
  for (const failure of failures) print(`FAIL ${failure}`);
  print(failures.length === 0 ? "PASS red-first check" : `FAIL red-first check: ${failures.length} finding(s)`);
  return failures.length === 0 ? 0 : 1;
}

/** Run the check; returns the exit status (0 pass, 1 findings, 2 usage or environment error). */
export function main(args: readonly string[], print: (line: string) => void = (line) => console.log(line)): number {
  try {
    return run(args, print);
  } catch (error) {
    if (error instanceof UsageError) {
      print(`error: ${error.message}`);
      print(USAGE);
      return 2;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.error(USAGE);
    process.exitCode = args.length === 0 ? 2 : 0;
  } else {
    process.exitCode = main(args);
  }
}
