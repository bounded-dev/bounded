// red-first-check — verify a branch's red commit and what became of its tests.
//
//   node scripts/workflow/red-first-check.ts <red-commit> [<branch>] [--package <dir>] [--repo <dir>]
//
// The development lifecycle (docs/harness-workflow.md, ADR 2026-068) has the
// builder commit failing tests alone, then implement. Given that red commit
// and the branch it sits on (default HEAD), this checks three things:
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
//
// Exit status: 0 all checks pass, 1 a check failed, 2 usage or environment
// error (no such commit, red commit not on the branch, test run produced no
// report).
//
// How test cases are compared, and the limits of that comparison. Files are
// parsed with the TypeScript compiler; nothing is executed. A case is a call
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
//     toBeDefined()), a case moved to another file or retitled (reported as
//     deleted), cases generated in loops or from helper-defined suites, and
//     test files the TypeScript parser cannot attribute. Cases whose text
//     changed in any way are listed as notes for the reviewer to read.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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
  return node.getText(file);
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

function runAtRed(repo: string, red: string, pkg: string, files: readonly string[], print: (line: string) => void): { failures: string[]; notes: string[] } {
  const installed = join(repo, pkg, "node_modules");
  if (!existsSync(installed)) throw new UsageError(`${relative(repo, installed)} is missing: run npm ci in ${pkg}/ first`);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "red-first-check-")));
  const tree = join(scratch, "tree");
  const report = join(scratch, "report.json");
  git(repo, "worktree", "add", "--detach", "--quiet", tree, red);
  try {
    symlinkSync(realpathSync(installed), join(tree, pkg, "node_modules"), "dir");
    const scoped = files.map((f) => relative(pkg, f));
    print(`red: running npm test at ${red.slice(0, 12)} on ${scoped.length} file(s)`);
    const run = spawnSync("npm", ["test", "--silent", "--", "--reporter=json", `--outputFile=${report}`, ...scoped], {
      cwd: join(tree, pkg), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1" },
    });
    if (!existsSync(report)) {
      throw new UsageError(`the test command wrote no report (exit ${run.status}):\n${(run.stderr || run.stdout).trim().slice(-2000)}`);
    }
    const results = (JSON.parse(readFileSync(report, "utf8")) as VitestReport).testResults ?? [];
    const failures: string[] = [];
    const notes: string[] = [];
    for (const file of files) {
      const absolute = join(tree, file);
      const result = results.find((r) => resolve(r.name) === absolute);
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
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: repo });
    rmSync(scratch, { recursive: true, force: true });
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
  for (const file of testFiles) {
    const cases = redCases(show(repo, `${red}^`, file), show(repo, red, file) ?? "", file);
    owned += cases.length;
    const at = headPathOf(repo, red, head, file);
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
