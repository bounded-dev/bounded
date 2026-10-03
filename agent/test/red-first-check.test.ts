// The red-first check lives with the repository's workflow tools in
// scripts/workflow/ (ADR 2026-068); its tests run here so `npm run check`
// covers it. The end-to-end cases build throwaway git repositories in a
// temporary directory, link this package's installed dependencies into them,
// and run the real check, which runs the real test command at the red commit.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  compareCases, extractTestCases, isRunnableTestPath, isTestPath, main, redCases,
} from "../../scripts/workflow/red-first-check.ts";

const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../scripts/workflow/red-first-check.ts", import.meta.url));

describe("which paths a red commit may touch", () => {
  test("test files and test fixtures count as test paths", () => {
    expect(isTestPath("agent/test/foo.test.ts")).toBe(true);
    expect(isTestPath("agent/src/ui/button.test.tsx")).toBe(true);
    expect(isTestPath("agent/packs/ts/scripts/testdata/pipeline/x/package.json")).toBe(true);
    expect(isTestPath("agent/test/fixtures/input.json")).toBe(true);
    expect(isTestPath("src/__fixtures__/a.ts")).toBe(true);
    expect(isTestPath("src/__snapshots__/a.test.ts.snap")).toBe(true);
  });

  test("source, helpers, configuration and docs do not", () => {
    expect(isTestPath("agent/src/gate.ts")).toBe(false);
    expect(isTestPath("agent/test/support/helpers.ts")).toBe(false);
    expect(isTestPath("agent/vitest.config.ts")).toBe(false);
    expect(isTestPath("agent/package.json")).toBe(false);
    expect(isTestPath("docs/harness-workflow.md")).toBe(false);
    expect(isTestPath("agent/src/latest.ts")).toBe(false);
    expect(isTestPath("agent/src/contest.ts")).toBe(false);
  });

  test("only test files outside fixture directories are run", () => {
    expect(isRunnableTestPath("agent/test/foo.test.ts")).toBe(true);
    expect(isRunnableTestPath("agent/src/ui/button.test.tsx")).toBe(true);
    expect(isRunnableTestPath("agent/packs/ts/scripts/testdata/a/a.test.ts")).toBe(false);
    expect(isRunnableTestPath("agent/test/fixtures/input.json")).toBe(false);
  });
});

describe("reading test cases from a file", () => {
  const SOURCE = [
    'import { describe, expect, it, test } from "vitest";',
    'describe("outer", () => {',
    '  describe("inner", () => {',
    '    test("adds", () => { expect(add(1, 2)).toBe(3); expect(add(0, 0)).toBe(0); });',
    "  });",
    '  it("throws", async () => { await expect(run()).rejects.toThrow(/bad/); });',
    '  it.skip("later", () => { expect(1).toBe(1); });',
    '  test.todo("someday");',
    "  test(`template title`, () => {});",
    '  test("expression body", () => expect(1).toBe(1));',
    "});",
    'test("top level", () => { assert.equal(1, 1); assert(true); expect.assertions(1); expect(x); });',
    'describe.skip("parked", () => { test("inside", () => { expect(1).toBe(1); }); });',
    'test.skipIf(process.env.CI)("conditional", () => { expect(1).toBe(1); });',
    'test.each([[1], [2]])("each %i", (n) => { expect(n).toBeGreaterThan(0); });',
    'test("same", () => { expect(1).toBe(1); });',
    'test("same", () => { expect(2).toBe(2); });',
  ].join("\n");
  const cases = extractTestCases(SOURCE, "example.test.ts");
  const byId = (id: string) => {
    const found = cases.find((c) => c.id === id);
    if (found === undefined) throw new Error(`no case ${id} in ${cases.map((c) => c.id).join(", ")}`);
    return found;
  };

  test("identifies each case by its describe path and title, in source order", () => {
    expect(cases.map((c) => c.id)).toEqual([
      "outer > inner > adds",
      "outer > throws",
      "outer > later",
      "outer > someday",
      "outer > template title",
      "outer > expression body",
      "top level",
      "parked > inside",
      "conditional",
      "each %i",
      "same",
      "same #2",
    ]);
    expect(byId("outer > inner > adds").line).toBe(4);
  });

  test("counts complete assertions, not bare expect calls", () => {
    expect(byId("outer > inner > adds").assertions).toBe(2);
    expect(byId("outer > throws").assertions).toBe(1);
    expect(byId("outer > expression body").assertions).toBe(1);
    // assert.equal, assert(...), expect.assertions(...) count; a bare expect(x) asserts nothing.
    expect(byId("top level").assertions).toBe(3);
  });

  test("records skipped cases, including those skipped by a describe or a condition", () => {
    expect(byId("outer > inner > adds").skipped).toBe(false);
    expect(byId("outer > later").skipped).toBe(true);
    expect(byId("outer > someday").skipped).toBe(true);
    expect(byId("parked > inside").skipped).toBe(true);
    expect(byId("conditional").skipped).toBe(true);
    expect(byId("each %i").skipped).toBe(false);
  });

  test("records the number of statements in the body", () => {
    expect(byId("outer > inner > adds").statements).toBe(2);
    expect(byId("outer > template title").statements).toBe(0);
    expect(byId("outer > expression body").statements).toBe(1);
    expect(byId("outer > someday").statements).toBe(0);
  });

  test("a .only elsewhere in the file skips every case it does not cover", () => {
    const only = extractTestCases('test.only("a", () => { expect(1).toBe(1); });\ntest("b", () => { expect(1).toBe(1); });');
    expect(only.map((c) => [c.id, c.skipped])).toEqual([["a", false], ["b", true]]);
    const describeOnly = extractTestCases('describe.only("d", () => { test("a", () => {}); });\ntest("b", () => {});');
    expect(describeOnly.map((c) => [c.id, c.skipped])).toEqual([["d > a", false], ["b", true]]);
  });

  test("ignores calls that are not tests", () => {
    expect(extractTestCases('const test2 = 1; latest("x", () => {}); expect(1).toBe(1);')).toEqual([]);
  });
});

describe("which cases the red commit owns", () => {
  const BEFORE = 'test("kept", () => { expect(1).toBe(1); });\ntest("changed", () => { expect(1).toBe(1); });';
  const AFTER = [
    'test("kept", () => {  expect(1).toBe(1);  });',
    'test("changed", () => { expect(1).toBe(2); });',
    'test("added", () => { expect(3).toBe(3); });',
  ].join("\n");

  test("new and changed cases belong to the red commit; untouched ones, even reformatted, do not", () => {
    expect(redCases(BEFORE, AFTER).map((c) => c.id)).toEqual(["changed", "added"]);
  });

  test("every case in a new file belongs to the red commit", () => {
    expect(redCases(undefined, AFTER).map((c) => c.id)).toEqual(["kept", "changed", "added"]);
  });
});

describe("weakening between the red commit and the branch head", () => {
  const RED = [
    'describe("d", () => {',
    '  test("one", () => { const v = f(); expect(v).toBe(1); expect(v).not.toBe(2); });',
    '  test("two", () => { expect(g()).toEqual([]); });',
    "});",
  ].join("\n");
  const red = extractTestCases(RED);
  const kinds = (head: string | undefined) =>
    compareCases(red, head === undefined ? undefined : extractTestCases(head)).map((w) => [w.id, w.kind]);

  test("an unchanged or strengthened suite passes", () => {
    expect(kinds(RED)).toEqual([]);
    expect(kinds(RED.replace("expect(g()).toEqual([]);", "expect(g()).toEqual([]); expect(h()).toBe(0);"))).toEqual([]);
  });

  test("a deleted file deletes every case", () => {
    expect(kinds(undefined)).toEqual([["d > one", "deleted"], ["d > two", "deleted"]]);
  });

  test("a removed or retitled case is deleted", () => {
    expect(kinds(RED.replace('"two"', '"two, renamed"'))).toEqual([["d > two", "deleted"]]);
  });

  test("skipping a case, its describe, or adding a .only elsewhere is skipping", () => {
    expect(kinds(RED.replace('test("one"', 'test.skip("one"'))).toEqual([["d > one", "skipped"]]);
    expect(kinds(RED.replace('test("one"', 'test.todo("one"'))).toEqual([["d > one", "skipped"]]);
    expect(kinds(RED.replace('describe("d"', 'describe.skip("d"'))).toEqual([["d > one", "skipped"], ["d > two", "skipped"]]);
    expect(kinds(RED.replace('test("one"', 'test.only("one"'))).toEqual([["d > two", "skipped"]]);
    expect(kinds(RED.replace('test("two"', 'test.fails("two"'))).toEqual([["d > two", "skipped"]]);
  });

  test("an emptied body is emptied", () => {
    expect(kinds(RED.replace("expect(g()).toEqual([]);", ""))).toEqual([["d > two", "emptied"]]);
  });

  test("fewer assertions is weakening, even when other statements remain", () => {
    expect(kinds(RED.replace(" expect(v).not.toBe(2);", ""))).toEqual([["d > one", "assertions-removed"]]);
    expect(kinds(RED.replace("expect(v).toBe(1); expect(v).not.toBe(2);", "expect(v);"))).toEqual([
      ["d > one", "assertions-removed"],
    ]);
  });

  test("each finding says what changed", () => {
    const [finding] = compareCases(red, extractTestCases(RED.replace(" expect(v).not.toBe(2);", "")));
    expect(finding?.detail).toMatch(/2 .*1/);
  });
});

// ---------------------------------------------------------------------------
// End to end, against throwaway repositories and the real test command.

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  }).trim();
}

function write(repo: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function commit(repo: string, message: string, files: Readonly<Record<string, string>>, removed: readonly string[] = []): string {
  write(repo, files);
  for (const path of removed) git(repo, "rm", "-q", path);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

const STUB = "export function add(a: number, b: number): number { return 0; }\n";
const IMPL = "export function add(a: number, b: number): number { return a + b; }\n";
const RED_TEST = [
  'import { expect, test } from "vitest";',
  'import { add } from "../src/add.ts";',
  'test("adds two numbers", () => { expect(add(1, 2)).toBe(3); });',
  'test("adds zero", () => { expect(add(5, 0)).toBe(5); expect(add(0, 5)).toBe(5); });',
  "",
].join("\n");

/** A repository whose package `pkg/` runs vitest from this package's installed dependencies. */
function fixtureRepo(): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), "red-first-"));
  temporary.push(repo);
  git(repo, "init", "-q", "-b", "main");
  const base = commit(repo, "base", {
    ".gitignore": "node_modules\n",
    "pkg/package.json": JSON.stringify({ type: "module", scripts: { test: "vitest run" } }),
    "pkg/src/add.ts": STUB,
    "README.md": "fixture\n",
  });
  symlinkSync(join(AGENT_DIR, "node_modules"), join(repo, "pkg/node_modules"), "dir");
  return { repo, base };
}

function check(repo: string, ...args: string[]): { code: number; out: string } {
  const lines: string[] = [];
  const code = main([...args, "--repo", repo, "--package", "pkg"], (line) => lines.push(line));
  return { code, out: lines.join("\n") };
}

describe("the check, end to end", () => {
  test("passes a red commit of failing tests that the build then turns green", () => {
    const { repo } = fixtureRepo();
    const red = commit(repo, "red", { "pkg/test/add.test.ts": RED_TEST });
    commit(repo, "green", { "pkg/src/add.ts": IMPL });
    const result = check(repo, red);
    expect(result.out).toMatch(/PASS/);
    expect(result.code).toBe(0);
  });

  test("fails a red commit that touches anything other than tests", () => {
    const { repo } = fixtureRepo();
    const red = commit(repo, "red", { "pkg/test/add.test.ts": RED_TEST, "pkg/src/add.ts": STUB.replace("0;", "-1;") });
    commit(repo, "green", { "pkg/src/add.ts": IMPL });
    const result = check(repo, red);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/pkg\/src\/add\.ts/);
  });

  test("fails a red commit whose tests already pass", () => {
    const { repo } = fixtureRepo();
    commit(repo, "implemented early", { "pkg/src/add.ts": IMPL });
    const red = commit(repo, "red", { "pkg/test/add.test.ts": RED_TEST });
    const result = check(repo, red);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/pkg\/test\/add\.test\.ts.*pass/i);
  });

  test("fails a branch head that weakened the red commit's tests", () => {
    const { repo } = fixtureRepo();
    const red = commit(repo, "red", { "pkg/test/add.test.ts": RED_TEST });
    commit(repo, "green", {
      "pkg/src/add.ts": IMPL,
      "pkg/test/add.test.ts": RED_TEST.replace('test("adds zero"', 'test.skip("adds zero"').replace(" expect(add(1, 2)).toBe(3);", ""),
    });
    const result = check(repo, red);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/adds zero.*skipped/);
    expect(result.out).toMatch(/adds two numbers.*emptied/);
  });

  test("follows a test file renamed after the red commit", () => {
    const { repo } = fixtureRepo();
    const red = commit(repo, "red", { "pkg/test/add.test.ts": RED_TEST });
    commit(repo, "green", { "pkg/src/add.ts": IMPL });
    git(repo, "mv", "pkg/test/add.test.ts", "pkg/test/sum.test.ts");
    git(repo, "commit", "-q", "-m", "rename");
    expect(check(repo, red).code).toBe(0);
  });

  test("refuses a red commit that is not on the branch, or a branch that does not exist", () => {
    const { repo, base } = fixtureRepo();
    const red = commit(repo, "red", { "pkg/test/add.test.ts": RED_TEST });
    expect(check(repo, red, base).code).toBe(2);
    expect(check(repo, "no-such-ref").code).toBe(2);
  });

  test("runs as a command and explains its usage", () => {
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      const failure = error as { status: number; stderr: string };
      status = failure.status;
      stderr = failure.stderr;
    }
    expect(status).toBe(2);
    expect(stderr).toMatch(/usage: .*red-first-check/i);
  });
});
