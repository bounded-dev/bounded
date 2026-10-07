// red-first-check — verify a branch's red commit and what became of its tests.
//
//   bun scripts/workflow/red-first-check.ts <red-commit> [<branch>] [--repo <dir>]
//
// The development lifecycle (docs/development-workflow.md, ADR 2026-001) has
// the builder commit failing tests alone, then implement. Given that red
// commit and the branch it sits on (default HEAD), this checks four things:
//
//   1. scope      the red commit adds or modifies only test files (*.test.ts,
//                 *.test.tsx), shared test code (*.test-support.ts) and test
//                 fixtures (anything under a testdata/, fixtures/,
//                 __fixtures__/ or __snapshots__/ directory). It deletes
//                 nothing, and adds at least one runnable test file.
//   2. red        each runnable test file the red commit touches fails when
//                 `bun test` runs it alone at the red commit, in a temporary
//                 worktree with the lockfile's dependencies installed. A file
//                 fails if any of its tests fails or it does not load. A new
//                 case that passes inside a failing file is a note.
//   3. preserved  at the branch head, none of the red commit's test cases (the
//                 cases it added or changed) is deleted, skipped, emptied, or
//                 left with fewer assertions. A file renamed after the red
//                 commit is followed through git's rename detection.
//   4. head       `bun test`, run at the branch head in a temporary worktree on
//                 those files (at their head paths) with the JUnit reporter,
//                 exits 0, collects every red case, runs it, sees it pass, and
//                 sees it make at least one assertion (bun's own per-case
//                 count). So a file renamed out of the runner's reach, a case
//                 skipped at run time, an early return or assertions behind a
//                 false condition all fail. Titles written with each-
//                 placeholders (%s, $name) or as templates or expressions
//                 match any reported title in that position.
//
// Superseded cases. A red case later replaced by design is recorded in
// superseded-tests.json (see parseSupersessions): it is then exempt from
// checks 3 and 4, its successor (if any) must exist, run and pass at the
// head, and each record is printed as a note. A red commit may itself carry
// that file, delete test paths, and delete a test file when every case in it
// is recorded. A red commit that changes fixtures under fixtures/compile-time/
// also runs compile-time.test.ts at the red commit, which must fail there.
// A record may change only in test-only commits after the red commit; a
// merge counts by the paths it changed itself (differing from every parent).
// A case recorded as superseded must not still exist at the head under the
// same id in its own file, followed through renames by git's rename
// detection; a case moved to an unrelated file is not detected.
//
// Exit status: 0 all checks pass, 1 a check failed, 2 usage or environment
// error (no such commit, red commit not on the branch, the test run produced
// no report).
//
// How test cases are compared (check 3), and the limits of that comparison.
// Files are parsed with the TypeScript compiler; nothing is executed. It
// COUNTS assertions and never reads them: expect(1).toBe(1) counts the same
// as the assertion it replaced, and the head run (check 4) only shows that
// some assertion ran. Whoever reviews must read every "changed" note. A case
// is a call to test(...) or it(...), with any modifier chain (test.skip,
// test.each(...), test.if(c)), identified by its file, the titles of the
// describe blocks around it and its own title, as written in the source (a
// template title is its source text). Repeated identities get " #2", " #3".
//   · A case is skipped if it, or a describe around it, uses skip, todo, if,
//     skipIf, todoIf or failing, or if a .only elsewhere in the file excludes it.
//   · A case is emptied if its callback has no statements, or it has none.
//   · An assertion is one complete expect(...).<matcher>(...) chain,
//     expect.assertions/hasAssertions(...), or an assert(...) call. A bare
//     expect(x) is not one. Only calls written inside the case's own callback
//     count: assertions inside helper functions it calls are invisible, so
//     moving assertions into a helper reads as removing them.
//   · Not detected: a changed matcher or expected value (toBe(3) becoming
//     toBeDefined()), a replaced or tautological assertion, an assertion
//     skipped on one path while another still runs, a case moved to another
//     file or retitled (reported as deleted), cases generated in loops or
//     from helper-defined suites (a *.test-support.ts conformance suite is
//     checked through the test files that run it). Cases whose text changed
//     in any way are listed as notes for the reviewer to read.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const USAGE = "usage: bun scripts/workflow/red-first-check.ts <red-commit> [<branch>] [--repo <dir>]";

// ---------------------------------------------------------------------------
// Paths

const FIXTURE_SEGMENTS = new Set(["testdata", "fixtures", "__fixtures__", "__snapshots__"]);
const TEST_FILE = /\.test\.tsx?$/;
const TEST_SUPPORT = /\.test-support\.tsx?$/;

function underFixtureDirectory(path: string): boolean {
  return path.split("/").slice(0, -1).some((segment) => FIXTURE_SEGMENTS.has(segment));
}

/** The record of superseded test cases, at the repository root. */
export const SUPERSESSIONS = "superseded-tests.json";

/** A path a red commit may touch: a test file, shared test code, a test fixture or the supersession record. */
export function isTestPath(path: string): boolean {
  return TEST_FILE.test(path) || TEST_SUPPORT.test(path) || underFixtureDirectory(path) || path === SUPERSESSIONS;
}

/** Fixture directories whose files are exercised by a test elsewhere: a change to them runs that test too. */
const FIXTURE_RUNNERS: readonly { readonly fixtures: string; readonly test: string }[] = [
  { fixtures: "/fixtures/compile-time/", test: "compile-time.test.ts" },
];

/** The tests that exercise fixtures among `paths`. */
export function fixtureRunners(paths: readonly string[]): string[] {
  return FIXTURE_RUNNERS.filter((runner) => paths.some((path) => path.includes(runner.fixtures))).map((runner) => runner.test);
}

// ---------------------------------------------------------------------------
// Supersession records
//
// A test case a red commit owns may later be replaced by design. It is then
// recorded in superseded-tests.json: its file and case id (as this script
// reads them), its successor (a case that must exist, run and pass at the
// head) or null, and the reason. Recorded cases are not reported as deleted,
// weakened or not run; each record is printed as a note for the reviewer.

export interface Supersession {
  readonly file: string;
  readonly case: string;
  readonly successor: { readonly file: string; readonly case: string } | null;
  readonly reason: string;
}

/**
 * Why a record cannot supersede `replaced`, or undefined. `headCases` are the
 * cases of the replaced case's file at the head (undefined when it is gone),
 * `successorCases` those of the successor's file.
 */
export function supersessionProblem(
  replaced: TestCase,
  record: Supersession,
  headCases: readonly TestCase[] | undefined,
  successorCases: readonly TestCase[] | undefined,
): string | undefined {
  if (record.successor !== null && record.successor.file === record.file && record.successor.case === replaced.id) return "names itself as its successor";
  if (headCases?.some((c) => c.id === replaced.id) === true) return "is recorded as superseded but still exists at the head";
  if (record.successor === null) return undefined;
  const { file, case: id } = record.successor;
  const successor = successorCases?.find((c) => c.id === id);
  if (successor === undefined) return `is superseded by ${file}: "${id}", which does not exist at the head`;
  const title = successor.titles.at(-1) ?? "";
  if (title.startsWith("`") && title.endsWith("`")) return `is superseded by ${file}: "${id}", a computed title (a table of cases); name one specific case`;
  if (successor.assertions < replaced.assertions) {
    return `is superseded by ${file}: "${id}", which makes ${successor.assertions} assertion(s), fewer than its ${replaced.assertions}`;
  }
  return undefined;
}

/** The records in the file's text (none when the file is absent), or why they cannot be read. */
export function parseSupersessions(text: string | undefined): { ok: true; value: Supersession[] } | { ok: false; error: string } {
  if (text === undefined) return { ok: true, value: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `${SUPERSESSIONS} is not valid JSON` };
  }
  const isText = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
  const records: Supersession[] = [];
  for (const entry of Array.isArray(raw) ? raw : [null]) {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const next = (typeof e.successor === "object" && e.successor !== null ? e.successor : {}) as Record<string, unknown>;
    const successorOk = e.successor === null || (isText(next.file) && isText(next.case));
    if (!isText(e.file) || !isText(e.case) || !isText(e.reason) || !successorOk) {
      return { ok: false, error: `${SUPERSESSIONS} must be a list of { file, case, successor: { file, case } | null, reason }, each with a reason` };
    }
    records.push({ file: e.file, case: e.case, successor: e.successor === null ? null : { file: String(next.file), case: String(next.case) }, reason: e.reason });
  }
  return { ok: true, value: records };
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
const GROUP_ROOTS = new Set(["describe"]);
const SKIPPING = new Set(["skip", "todo", "if", "skipIf", "todoIf", "failing"]);

/** The root identifier and modifier names of a callee like `test.skipIf(c)` or `test.each([...])`. */
function calleeChain(callee: ts.Expression): { root: string; modifiers: string[] } | undefined {
  const modifiers: string[] = [];
  let node: ts.Expression = callee;
  for (;;) {
    if (ts.isIdentifier(node)) return { root: node.text, modifiers: modifiers.reverse() };
    if (ts.isPropertyAccessExpression(node)) {
      modifiers.push(node.name.text);
      node = node.expression;
      continue;
    }
    if (ts.isCallExpression(node)) {
      node = node.expression;
      continue;
    }
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
  return call.arguments
    .slice(1)
    .find((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
}

function statementCount(fn: ts.ArrowFunction | ts.FunctionExpression | undefined): number {
  if (fn === undefined) return 0;
  return ts.isBlock(fn.body) ? fn.body.statements.length : 1;
}

/** Whether a call `expect(...)` is continued by a matcher call further up its chain. */
function hasMatcherCall(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  for (;;) {
    const parent: ts.Node = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      node = parent;
      continue;
    }
    return ts.isCallExpression(parent) && parent.expression === node;
  }
}

function countAssertions(root: ts.Node | undefined): number {
  if (root === undefined) return 0;
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (callee.text === "assert") count++;
        else if (callee.text === "expect" && hasMatcherCall(node)) count++;
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const owner = callee.expression.text;
        const name = callee.name.text;
        if (owner === "expect" && (name === "assertions" || name === "hasAssertions")) count++;
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
  interface Raw {
    titles: string[];
    line: number;
    skipped: boolean;
    underOnly: boolean;
    statements: number;
    assertions: number;
    text: string;
  }
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
            titles: path,
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            skipped: skips,
            underOnly: underOnly || only,
            statements: statementCount(callback),
            assertions: countAssertions(callback?.body),
            text: collapse(node.getText(file)),
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
      id: n === 1 ? base : `${base} #${n}`,
      titles: r.titles,
      line: r.line,
      skipped: r.skipped || (fileHasOnly && !r.underOnly),
      statements: r.statements,
      assertions: r.assertions,
      text: r.text,
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
export interface Weakening {
  readonly id: string;
  readonly kind: WeakeningKind;
  readonly detail: string;
}

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
// The JUnit report bun writes

export interface ReportedCase {
  /** Repository-relative path of the test file. */
  readonly file: string;
  /** Describe titles, then the case title. */
  readonly titles: readonly string[];
  readonly status: "passed" | "failed" | "skipped";
  readonly assertions: number;
}

const unescapeXml = (text: string): string =>
  text.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => {
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    if (entity === "amp") return "&";
    return String.fromCodePoint(entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10));
  });

function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out.set(match[1] ?? "", unescapeXml(match[2] ?? ""));
  return out;
}

/**
 * Every test case in bun's JUnit report. The outermost testsuite of each file
 * is the file itself; nested testsuites are describe blocks.
 */
export function parseJunit(xml: string): ReportedCase[] {
  const out: ReportedCase[] = [];
  const suites: { name: string; file: string }[] = [];
  let open: { file: string; titles: string[]; status: ReportedCase["status"]; assertions: number } | undefined;
  for (const match of xml.matchAll(/<(\/?)(testsuites|testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g)) {
    const [, closing, name, rest = "", selfClosing] = match;
    if (name === "testsuite") {
      if (closing === "/") suites.pop();
      else if (selfClosing !== "/") {
        const attrs = attributes(rest);
        suites.push({ name: attrs.get("name") ?? "", file: attrs.get("file") ?? attrs.get("name") ?? "" });
      }
      continue;
    }
    if (name === "testcase") {
      if (closing === "/") {
        if (open !== undefined) out.push(open);
        open = undefined;
        continue;
      }
      const attrs = attributes(rest);
      const file = suites[0]?.file ?? attrs.get("file") ?? "";
      const titles = [...suites.slice(1).map((s) => s.name), attrs.get("name") ?? ""];
      const entry = { file, titles, status: "passed" as ReportedCase["status"], assertions: Number(attrs.get("assertions") ?? "0") };
      if (selfClosing === "/") out.push(entry);
      else open = entry;
      continue;
    }
    if (open !== undefined && closing !== "/") {
      if (name === "failure" || name === "error") open.status = "failed";
      else if (name === "skipped" && open.status !== "failed") open.status = "skipped";
    }
  }
  return out;
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

interface Change {
  readonly status: string;
  readonly path: string;
  readonly from?: string;
}

function parseNameStatus(output: string): Change[] {
  return output
    .split("\n")
    .filter((l) => l !== "")
    .map((line) => {
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
// Running bun test at a commit

/**
 * Check out `commit` in a temporary worktree, install the lockfile's
 * dependencies there (the workspace links must point into that tree, not
 * this checkout), and hand the tree to `use`. The worktree is always removed.
 */
function inWorktree<T>(repo: string, commit: string, use: (tree: string, scratch: string) => T): T {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "red-first-check-")));
  const tree = join(scratch, "tree");
  git(repo, "worktree", "add", "--detach", "--quiet", tree, commit);
  try {
    if (existsSync(join(tree, "package.json"))) {
      const install = spawnSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: tree, encoding: "utf8" });
      if (install.status !== 0) {
        throw new UsageError(`bun install failed at ${commit.slice(0, 12)}:\n${(install.stderr || install.stdout).trim().slice(-2000)}`);
      }
    }
    return use(tree, scratch);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: repo });
    rmSync(scratch, { recursive: true, force: true });
  }
}

function bunTest(tree: string, files: readonly string[], report?: string): { status: number | null; output: string } {
  const args = ["test", ...(report === undefined ? [] : ["--reporter=junit", `--reporter-outfile=${report}`]), ...files.map((f) => `./${f}`)];
  const run = spawnSync("bun", args, { cwd: tree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1" } });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/** A title as written becomes a pattern for the titles the runner reports (each/template placeholders match anything). */
function titlePattern(title: string): RegExp {
  const source = title.startsWith("`") && title.endsWith("`") && title.length >= 2 ? title.slice(1, -1) : title;
  const parts = source.split(/(%[sdifjoOpc#%]|\$\{[^}]*\}|\$[\w.]+)/);
  return new RegExp(`^${parts.map((part, i) => (i % 2 === 1 ? ".*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`, "s");
}

function matchesTitles(patterns: readonly RegExp[], titles: readonly string[]): boolean {
  return patterns.length === titles.length && patterns.every((p, i) => p.test(titles[i] ?? ""));
}

function runAtRed(repo: string, red: string, files: readonly string[], print: (line: string) => void): { failures: string[]; notes: string[] } {
  print(`red: running bun test at ${red.slice(0, 12)} on ${files.length} file(s), one at a time`);
  return inWorktree(repo, red, (tree, scratch) => {
    const failures: string[] = [];
    const notes: string[] = [];
    files.forEach((file, index) => {
      const report = join(scratch, `red-${index}.xml`);
      const run = bunTest(tree, [file], report);
      const cases = existsSync(report) ? parseJunit(readFileSync(report, "utf8")) : [];
      const passed = cases.filter((c) => c.status === "passed").length;
      if (run.status === 0) {
        failures.push(`${file}: every test passes at the red commit (${passed} passed); a red test must fail before the build`);
        return;
      }
      const failed = cases.filter((c) => c.status === "failed").length;
      print(`red: ${file} fails at the red commit (${cases.length === 0 ? "does not load" : `${failed} failed, ${passed} passed`})`);
      const owned = new Set(redCases(show(repo, `${red}^`, file), show(repo, red, file) ?? "", file).map((c) => c.titles.join(" > ")));
      for (const c of cases) {
        const id = c.titles.join(" > ");
        if (c.status === "passed" && owned.has(id)) notes.push(`${file}: new case "${id}" already passes at the red commit`);
      }
    });
    return { failures, notes };
  });
}

/** At the head, every red case must be collected, executed, passing, and must make at least one assertion. */
function checkAtHead(repo: string, head: string, owned: ReadonlyMap<string, readonly TestCase[]>, print: (line: string) => void): string[] {
  const files = [...owned.keys()];
  if (files.length === 0) return [];
  print(`head: running bun test at ${head.slice(0, 12)} on ${files.length} file(s)`);
  return inWorktree(repo, head, (tree, scratch) => {
    const report = join(scratch, "head.xml");
    const run = bunTest(tree, files, report);
    if (!existsSync(report)) throw new UsageError(`bun test wrote no report (exit ${run.status}):\n${run.output.trim().slice(-2000)}`);
    const reported = parseJunit(readFileSync(report, "utf8"));
    const failures: string[] = [];
    if (run.status !== 0) failures.push(`bun test exits ${run.status} at the head on the red commit's files:\n${run.output.trim().slice(-1500)}`);
    for (const [file, cases] of owned) {
      const inFile = reported.filter((r) => r.file === file);
      if (inFile.length === 0) {
        failures.push(`${file}: bun test does not collect it at the head, so none of its ${cases.length} red case(s) runs`);
        continue;
      }
      for (const c of cases) {
        const patterns = c.titles.map(titlePattern);
        const runs = inFile.filter((r) => matchesTitles(patterns, r.titles));
        if (runs.length === 0) {
          failures.push(`${file}: "${c.id}" was not run at the head`);
          continue;
        }
        const statuses = [...new Set(runs.map((r) => r.status).filter((s) => s !== "passed"))];
        if (statuses.length > 0) {
          failures.push(`${file}: "${c.id}" ${statuses.join(", ")} at the head`);
          continue;
        }
        if (runs.some((r) => r.assertions === 0)) failures.push(`${file}: "${c.id}" passed with no assertions at the head`);
      }
    }
    return failures;
  });
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
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--repo") {
      const value = args[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      repoArg = value;
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

  const recordsAt = (commit: string): Supersession[] => {
    const parsed = parseSupersessions(show(repo, commit, SUPERSESSIONS));
    if (!parsed.ok) throw new UsageError(`${parsed.error} at ${commit.slice(0, 12)}`);
    return parsed.value;
  };
  const atRedRecords = recordsAt(red);
  const headRecords = recordsAt(head);
  const recorded = (records: readonly Supersession[], file: string, id: string) => records.find((r) => r.file === file && r.case === id);

  // 1. scope
  const changes = parseNameStatus(git(repo, "diff-tree", "-r", "--no-commit-id", "--name-status", "-M", `${red}^`, red));
  for (const change of changes) {
    if (change.status === "D") {
      // A red commit may delete a test path; a runnable test file only when
      // every case in it is recorded as superseded by the red commit's record.
      if (!isTestPath(change.path)) failures.push(`scope: the red commit deletes ${change.path}, which is not a test path`);
      else if (isRunnableTestPath(change.path)) {
        for (const c of extractTestCases(show(repo, `${red}^`, change.path) ?? "", change.path)) {
          if (recorded(atRedRecords, change.path, c.id) === undefined) {
            failures.push(`scope: the red commit deletes ${change.path}, whose case "${c.id}" no record in ${SUPERSESSIONS} supersedes`);
          }
        }
      }
    } else if (!isTestPath(change.path)) failures.push(`scope: ${change.path} is not a test file, test support or test fixture`);
    else if (change.from !== undefined && !isTestPath(change.from)) failures.push(`scope: ${change.path} was moved from ${change.from}, which is not a test path`);
  }
  const testFiles = changes.filter((c) => c.status !== "D" && isRunnableTestPath(c.path)).map((c) => c.path);
  if (testFiles.length === 0) failures.push("scope: the red commit adds or changes no runnable test file");
  const runners = fixtureRunners(changes.map((c) => c.path)).filter((f) => !testFiles.includes(f) && show(repo, red, f) !== undefined);
  print(`scope: ${changes.length} path(s) in the red commit, ${testFiles.length} runnable test file(s)${runners.length > 0 ? `, plus ${runners.join(", ")} for its fixtures` : ""}`);

  // The record may change only in test-only commits after the red commit, so
  // a build can never quietly supersede the tests it should pass.
  for (const commit of git(repo, "log", "--format=%H", `${red}..${head}`, "--", SUPERSESSIONS).split("\n").filter((l) => l !== "")) {
    // For a merge, the paths it changed itself: those differing from every
    // parent (--cc). Its parents' own commits are listed and checked here too.
    const merge = git(repo, "rev-list", "--parents", "-n", "1", commit).trim().split(" ").length > 2;
    const paths = git(repo, "diff-tree", ...(merge ? ["--cc"] : ["-r", "--root"]), "--no-commit-id", "--name-only", commit)
      .split("\n")
      .filter((l) => l !== "");
    if (!paths.every(isTestPath)) failures.push(`supersessions: ${SUPERSESSIONS} was changed by ${commit.slice(0, 12)}, which is not a test-only commit`);
  }

  // 2. red
  if (testFiles.length > 0 || runners.length > 0) {
    const result = runAtRed(repo, red, [...testFiles, ...runners], print);
    failures.push(...result.failures.map((f) => `red: ${f}`));
    notes.push(...result.notes);
  }

  // 3. preserved
  let ownedCount = 0;
  const atHead = new Map<string, TestCase[]>();
  const addAtHead = (file: string, cases: readonly TestCase[]) => {
    if (cases.length > 0) atHead.set(file, [...(atHead.get(file) ?? []), ...cases]);
  };
  for (const file of testFiles) {
    const owned = redCases(show(repo, `${red}^`, file), show(repo, red, file) ?? "", file);
    ownedCount += owned.length;
    const at = headPathOf(repo, red, head, file);
    const source = at === undefined ? undefined : show(repo, head, at);
    const headCases = source === undefined ? undefined : extractTestCases(source, at);
    const cases: TestCase[] = [];
    for (const c of owned) {
      const record = recorded(headRecords, file, c.id);
      if (record === undefined) {
        cases.push(c);
        continue;
      }
      const problem = supersessionProblem(c, record, headCases, record.successor === null ? undefined : extractTestCases(show(repo, head, record.successor.file) ?? "", record.successor.file));
      if (problem !== undefined) {
        failures.push(`preserved: ${file}: "${c.id}" ${problem}`);
        continue;
      }
      if (record.successor === null) {
        notes.push(`${file}: "${c.id}" is superseded with no successor (${record.reason})`);
        continue;
      }
      const { file: nextFile, case: nextCase } = record.successor;
      notes.push(`${file}: "${c.id}" is superseded by ${nextFile}: "${nextCase}" (${record.reason})`);
      const successor = extractTestCases(show(repo, head, nextFile) ?? "", nextFile).find((n) => n.id === nextCase);
      if (successor !== undefined) addAtHead(nextFile, [successor]);
    }
    if (at !== undefined) addAtHead(at, cases);
    for (const w of compareCases(cases, headCases)) failures.push(`preserved: ${file}: "${w.id}" ${w.kind} (${w.detail})`);
    const now = new Map((headCases ?? []).map((c) => [c.id, c.text]));
    for (const c of cases) {
      const text = now.get(c.id);
      if (text !== undefined && text !== c.text) notes.push(`${at ?? file}: "${c.id}" changed since the red commit; read the change`);
    }
  }
  print(`preserved: ${ownedCount} test case(s) from the red commit compared at ${head.slice(0, 12)}`);

  // 4. head
  failures.push(...checkAtHead(repo, head, atHead, print).map((f) => `head: ${f}`));

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

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.error(USAGE);
    process.exitCode = args.length === 0 ? 2 : 0;
  } else {
    process.exitCode = main(args);
  }
}
