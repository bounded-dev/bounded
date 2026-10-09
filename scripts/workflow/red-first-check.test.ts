import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareCases, extractTestCases, FIXTURE_RUNNERS, fixtureRunners, isRunnableTestPath, isTestPath, main, parseJunit, parseSupersessions, redCases } from "./red-first-check.ts";

describe("red-first-check paths", () => {
  test("test files, test support and fixtures may be in a red commit; nothing else", () => {
    expect(isTestPath("src/core/a.test.ts")).toBe(true);
    expect(isTestPath("src/core/a.store.test-support.ts")).toBe(true);
    expect(isTestPath("src/core/test/fixtures/bad.ts")).toBe(true);
    expect(isTestPath("src/core/a.ts")).toBe(false);
    expect(isTestPath("package.json")).toBe(false);
    expect(isTestPath("superseded-tests.json")).toBe(true);
  });

  test("a change to the compile-time fixtures also runs the test that compiles them", () => {
    expect(fixtureRunners(["src/test/fixtures/compile-time/rejected.ts", "a.test.ts"])).toEqual(["src/test/compile-time.test.ts"]);
    expect(fixtureRunners(["src/core/test/fixtures/other/x.ts"])).toEqual([]);
  });

  test("every fixture runner's test exists in the repository", () => {
    const repoRoot = join(import.meta.dir, "..", "..");
    expect(FIXTURE_RUNNERS.length).toBeGreaterThan(0);
    for (const runner of FIXTURE_RUNNERS) expect([runner.test, existsSync(join(repoRoot, runner.test))]).toEqual([runner.test, true]);
  });

  test("only test files outside fixture directories are runnable", () => {
    expect(isRunnableTestPath("a.test.ts")).toBe(true);
    expect(isRunnableTestPath("fixtures/a.test.ts")).toBe(false);
    expect(isRunnableTestPath("a.test-support.ts")).toBe(false);
  });
});

describe("red-first-check cases", () => {
  const source = `
    describe("group", () => {
      test("one", () => { expect(1).toBe(1); expect(2).toBe(2); });
      test.skip("two", () => { expect(1).toBe(1); });
      test.if(false)("three", () => { expect(1).toBe(1); });
      test("four", () => {});
    });`;

  test("reads titles, skips, statements and assertions", () => {
    const cases = extractTestCases(source);
    expect(cases.map((c) => [c.id, c.skipped, c.statements, c.assertions])).toEqual([
      ["group > one", false, 2, 2],
      ["group > two", true, 1, 1],
      ["group > three", true, 1, 1],
      ["group > four", false, 0, 0],
    ]);
  });

  test("a .only elsewhere skips every other case", () => {
    const cases = extractTestCases(`test.only("a", () => { expect(1).toBe(1); }); test("b", () => { expect(1).toBe(1); });`);
    expect(cases.map((c) => c.skipped)).toEqual([false, true]);
  });

  test("a red commit owns the cases it added or changed", () => {
    const before = `test("a", () => { expect(1).toBe(1); }); test("b", () => { expect(1).toBe(1); });`;
    const after = `test("a", () => { expect(1).toBe(1); }); test("b", () => { expect(2).toBe(2); }); test("c", () => { expect(3).toBe(3); });`;
    expect(redCases(before, after).map((c) => c.id)).toEqual(["b", "c"]);
  });

  test("finds deleted, skipped, emptied and weakened cases", () => {
    const red = extractTestCases(`test("a", () => { expect(1).toBe(1); expect(2).toBe(2); }); test("b", () => { expect(1).toBe(1); }); test("c", () => { expect(1).toBe(1); }); test("d", () => { expect(1).toBe(1); });`);
    const head = extractTestCases(`test("a", () => { expect(1).toBe(1); }); test.skip("b", () => { expect(1).toBe(1); }); test("c", () => {});`);
    expect(compareCases(red, head).map((w) => [w.id, w.kind])).toEqual([
      ["a", "assertions-removed"],
      ["b", "skipped"],
      ["c", "emptied"],
      ["d", "deleted"],
    ]);
    expect(compareCases(red, undefined).every((w) => w.kind === "deleted")).toBe(true);
  });
});

describe("red-first-check supersession records", () => {
  test("reads records naming the case, its successor or none, and the reason", () => {
    const text = JSON.stringify([
      { file: "a.test.ts", case: "g > old", successor: { file: "b.test.ts", case: "g > new" }, reason: "moved" },
      { file: "a.test.ts", case: "gone", successor: null, reason: "the behaviour was removed by design" },
    ]);
    expect(parseSupersessions(text)).toEqual({
      ok: true,
      value: [
        { file: "a.test.ts", case: "g > old", successor: { file: "b.test.ts", case: "g > new" }, reason: "moved" },
        { file: "a.test.ts", case: "gone", successor: null, reason: "the behaviour was removed by design" },
      ],
    });
    expect(parseSupersessions(undefined)).toEqual({ ok: true, value: [] });
  });

  test("refuses a record without a reason, or malformed", () => {
    expect(parseSupersessions(JSON.stringify([{ file: "a.test.ts", case: "x", successor: null, reason: " " }])).ok).toBe(false);
    expect(parseSupersessions("{").ok).toBe(false);
    expect(parseSupersessions(JSON.stringify([{ file: "a.test.ts" }])).ok).toBe(false);
  });
});

describe("red-first-check JUnit", () => {
  test("reads nested describes, statuses and assertion counts", () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite name="a.test.ts" file="a.test.ts"><testsuite name="g &amp; h" file="a.test.ts">
      <testcase name="ok" classname="g" assertions="2" />
      <testcase name="bad" classname="g" assertions="1"><failure type="AssertionError" /></testcase>
      <testcase name="skip" classname="g" assertions="0"><skipped /></testcase>
    </testsuite><testcase name="top" assertions="1" /></testsuite></testsuites>`;
    expect(parseJunit(xml)).toEqual([
      { file: "a.test.ts", titles: ["g & h", "ok"], status: "passed", assertions: 2 },
      { file: "a.test.ts", titles: ["g & h", "bad"], status: "failed", assertions: 1 },
      { file: "a.test.ts", titles: ["g & h", "skip"], status: "skipped", assertions: 0 },
      { file: "a.test.ts", titles: ["top"], status: "passed", assertions: 1 },
    ]);
  });
});

/** A throwaway repository: a base commit, a red commit, and a build on top. */
function repository(): { dir: string; commit: (files: Record<string, string>, message: string) => string; git: (...args: string[]) => string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "red-first-repo-")));
  const git = (...args: string[]): string => {
    const run = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: dir, encoding: "utf8" });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  git("init", "--quiet", "-b", "main");
  const commit = (files: Record<string, string>, message: string): string => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    git("add", "-A");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  commit({ "package.json": '{"name":"t","private":true}\n' }, "base");
  return { dir, commit, git };
}

const RED_TEST = `import { expect, test } from "bun:test";\nimport { sum } from "./sum.ts";\ntest("adds", () => { expect(sum(1, 2)).toBe(3); });\n`;

describe("red-first-check end to end", () => {
  test("passes a red commit whose test fails, then passes unweakened", () => {
    const repo = repository();
    const red = repo.commit({ "sum.test.ts": RED_TEST }, "red");
    repo.commit({ "sum.ts": "export const sum = (a: number, b: number): number => a + b;\n" }, "green");
    const lines: string[] = [];
    expect(main([red, "HEAD", "--repo", repo.dir], (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toBe("PASS red-first check");
  }, 30_000);

  test("fails a red commit that ships implementation, and a test weakened at the head", () => {
    const repo = repository();
    const red = repo.commit({ "sum.test.ts": RED_TEST, "sum.ts": "export const sum = (a: number, b: number): number => a - b;\n" }, "red");
    repo.commit({ "sum.test.ts": `import { test } from "bun:test";\ntest("adds", () => { void 0; });\n` }, "weaken");
    const lines: string[] = [];
    expect(main([red, "HEAD", "--repo", repo.dir], (l) => lines.push(l))).toBe(1);
    expect(lines).toContain("FAIL scope: sum.ts is not a test file, test support or test fixture");
    expect(lines).toContain('FAIL preserved: sum.test.ts: "adds" assertions-removed (assertions went from 1 to 0)');
    expect(lines.some((l) => l.startsWith('FAIL head: sum.test.ts: "adds" passed with no assertions'))).toBe(true);
  }, 30_000);

  test("fails a red commit whose tests already pass", () => {
    const repo = repository();
    const red = repo.commit({ "ok.test.ts": `import { expect, test } from "bun:test";\ntest("t", () => { expect(1).toBe(1); });\n` }, "red");
    const lines: string[] = [];
    expect(main([red, "HEAD", "--repo", repo.dir], (l) => lines.push(l))).toBe(1);
    expect(lines.some((l) => l.startsWith("FAIL red: ok.test.ts: every test passes at the red commit"))).toBe(true);
  }, 30_000);

  test("a test file moved, then rewritten beyond git's rename detection, is still followed rename by rename", () => {
    const repo = repository();
    mkdirSync(join(repo.dir, "a"));
    mkdirSync(join(repo.dir, "b"));
    const moved = RED_TEST.replace('"./sum.ts"', '"../sum.ts"');
    const red = repo.commit({ "a/sum.test.ts": moved }, "red");
    repo.commit({ "sum.ts": "export const sum = (a: number, b: number): number => a + b;\n" }, "green");
    repo.git("mv", "a/sum.test.ts", "b/sum.test.ts");
    repo.git("commit", "--quiet", "-m", "move");
    const others = Array.from({ length: 12 }, (_, i) => `test("adds ${i} and ${i}", () => { expect(sum(${i}, ${i})).toBe(${2 * i}); });`).join("\n");
    repo.commit({ "b/sum.test.ts": `${moved}${others}\n` }, "grow");
    const lines: string[] = [];
    expect(main([red, "HEAD", "--repo", repo.dir], (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toBe("PASS red-first check");
  }, 30_000);

  test("a red case superseded by a recorded successor passes; the successor must exist, run and pass", () => {
    const repo = repository();
    const red = repo.commit({ "sum.test.ts": RED_TEST }, "red");
    repo.commit({ "sum.ts": "export const sum = (a: number, b: number): number => a + b;\n" }, "green");
    const replaced = `import { expect, test } from "bun:test";\nimport { sum } from "./sum.ts";\ntest("adds two numbers", () => { expect(sum(2, 2)).toBe(4); });\n`;
    repo.commit({ "sum.test.ts": replaced }, "rename without a record");
    const without: string[] = [];
    expect(main([red, "HEAD", "--repo", repo.dir], (l) => without.push(l))).toBe(1);
    const record = (successor: string) =>
      JSON.stringify([{ file: "sum.test.ts", case: "adds", successor: { file: "sum.test.ts", case: successor }, reason: "renamed to say what it adds" }]);
    repo.commit({ "superseded-tests.json": record("adds two numbers") }, "record it");
    const lines: string[] = [];
    expect(main([red, "HEAD", "--repo", repo.dir], (l) => lines.push(l))).toBe(0);
    expect(lines).toContain('note: sum.test.ts: "adds" is superseded by sum.test.ts: "adds two numbers" (renamed to say what it adds)');
    repo.commit({ "superseded-tests.json": record("no such case") }, "record a successor that does not exist");
    const missing: string[] = [];
    expect(main([red, "HEAD", "--repo", repo.dir], (l) => missing.push(l))).toBe(1);
    expect(missing).toContain('FAIL preserved: sum.test.ts: "adds" is superseded by sum.test.ts: "no such case", which does not exist at the head');
  }, 60_000);

  describe("a supersession record is refused when", () => {
    const SUM = "export const sum = (a: number, b: number): number => a + b;\n";
    const HEADER = `import { expect, test } from "bun:test";\nimport { sum } from "./sum.ts";\n`;
    const record = (successor: { file: string; case: string } | null) => JSON.stringify([{ file: "sum.test.ts", case: "adds", successor, reason: "replaced" }]);
    /** A red commit owning "adds" (two assertions), a build, then `later` commits; the check's output lines. */
    const check = (later: Record<string, string>[]): string[] => {
      const repo = repository();
      const red = repo.commit({ "sum.test.ts": `${HEADER}test("adds", () => { expect(sum(1, 2)).toBe(3); expect(sum(2, 2)).toBe(4); });\n` }, "red");
      repo.commit({ "sum.ts": SUM }, "green");
      for (const [i, files] of later.entries()) repo.commit(files, `later ${i}`);
      const lines: string[] = [];
      main([red, "HEAD", "--repo", repo.dir], (l) => lines.push(l));
      return lines;
    };

    test("the case it supersedes still exists at the head", () => {
      expect(check([{ "superseded-tests.json": record(null) }])).toContain('FAIL preserved: sum.test.ts: "adds" is recorded as superseded but still exists at the head');
    }, 60_000);

    test("a case names itself as its successor", () => {
      expect(check([{ "superseded-tests.json": record({ file: "sum.test.ts", case: "adds" }) }])).toContain(
        'FAIL preserved: sum.test.ts: "adds" names itself as its successor',
      );
    }, 60_000);

    test("the successor is a whole table of cases generated in a loop", () => {
      const table = `${HEADER}for (const [a, b] of [[1, 2]]) test(String(a), () => { expect(sum(a ?? 0, b ?? 0)).toBe(3); expect(sum(2, 2)).toBe(4); });\n`;
      // The id of a case with a computed title is its source text, a template.
      const computed = ["`$", "{String(a)}`"].join("");
      expect(check([{ "sum.test.ts": table, "superseded-tests.json": record({ file: "sum.test.ts", case: computed }) }])).toContain(
        `FAIL preserved: sum.test.ts: "adds" is superseded by sum.test.ts: "${computed}", a computed title (a table of cases); name one specific case`,
      );
    }, 60_000);

    test("the successor makes fewer assertions than the case it replaces", () => {
      const weaker = `${HEADER}test("adds two numbers", () => { expect(sum(1, 2)).toBe(3); });\n`;
      expect(check([{ "sum.test.ts": weaker, "superseded-tests.json": record({ file: "sum.test.ts", case: "adds two numbers" }) }])).toContain(
        'FAIL preserved: sum.test.ts: "adds" is superseded by sum.test.ts: "adds two numbers", which makes 1 assertion(s), fewer than its 2',
      );
    }, 60_000);

    test("the record was changed by a commit that is not test-only", () => {
      const renamed = `${HEADER}test("adds two numbers", () => { expect(sum(1, 2)).toBe(3); expect(sum(2, 2)).toBe(4); });\n`;
      const lines = check([{ "sum.test.ts": renamed, "sum.ts": `${SUM}// touched\n`, "superseded-tests.json": record({ file: "sum.test.ts", case: "adds two numbers" }) }]);
      expect(lines.some((l) => /^FAIL supersessions: superseded-tests\.json was changed by [0-9a-f]{12}, which is not a test-only commit$/.test(l))).toBe(true);
    }, 60_000);
  });

  test("a merge that changes the record and code itself (an evil merge) is not test-only", () => {
    const repo = repository();
    const red = repo.commit({ "sum.test.ts": RED_TEST }, "red");
    repo.git("checkout", "--quiet", "-b", "build");
    repo.commit({ "sum.ts": "export const sum = (a: number, b: number): number => a + b;\n" }, "green");
    repo.git("checkout", "--quiet", "main");
    repo.commit({ "notes.test.ts": `import { expect, test } from "bun:test";\ntest("n", () => { expect(1).toBe(1); });\n` }, "test-only on main");
    repo.git("merge", "--quiet", "--no-ff", "--no-commit", "build");
    // The merge invents a record neither side had, and changes code.
    writeFileSync(join(repo.dir, "superseded-tests.json"), JSON.stringify([{ file: "x.test.ts", case: "x", successor: null, reason: "invented in the merge" }]));
    writeFileSync(join(repo.dir, "sum.ts"), "export const sum = (a: number, b: number): number => b + a;\n");
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "--no-edit");
    const lines: string[] = [];
    expect(main([red, "HEAD", "--repo", repo.dir], (l) => lines.push(l))).toBe(1);
    expect(lines.some((l) => /^FAIL supersessions: superseded-tests\.json was changed by [0-9a-f]{12}, which is not a test-only commit$/.test(l))).toBe(true);
  }, 60_000);

  test("a merge whose record is exactly the union of its parents' records passes, whatever else it resolves", () => {
    const record = (reason: string) => ({ file: "old.test.ts", case: reason, successor: null, reason });
    const repo = repository();
    const red = repo.commit({ "sum.test.ts": RED_TEST }, "red");
    repo.git("checkout", "--quiet", "-b", "build");
    repo.commit({ "sum.ts": "export const sum = (a: number, b: number): number => a + b;\n", "notes.md": "build\n" }, "green");
    repo.commit({ "superseded-tests.json": JSON.stringify([record("from build")]) }, "record on build");
    repo.git("checkout", "--quiet", "main");
    repo.commit({ "notes.md": "main\n" }, "docs on main");
    repo.commit({ "superseded-tests.json": JSON.stringify([record("from main")]) }, "record on main");
    // Both sides changed the record and notes.md: the merge stops on conflicts, resolved below.
    spawnSync("git", ["merge", "--quiet", "--no-ff", "--no-commit", "build"], { cwd: repo.dir });
    writeFileSync(join(repo.dir, "superseded-tests.json"), JSON.stringify([record("from main"), record("from build")]));
    writeFileSync(join(repo.dir, "notes.md"), "main and build\n");
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "--no-edit");
    const lines: string[] = [];
    expect(main([red, "HEAD", "--repo", repo.dir], (l) => lines.push(l))).toBe(0);
  }, 60_000);

  test("an ordinary merge of a build branch passes", () => {
    const repo = repository();
    const red = repo.commit({ "sum.test.ts": RED_TEST }, "red");
    repo.git("checkout", "--quiet", "-b", "build");
    repo.commit({ "sum.ts": "export const sum = (a: number, b: number): number => a + b;\n" }, "green");
    repo.git("checkout", "--quiet", "main");
    repo.git("merge", "--quiet", "--no-ff", "-m", "merge build", "build");
    const lines: string[] = [];
    expect(main([red, "HEAD", "--repo", repo.dir], (l) => lines.push(l))).toBe(0);
  }, 60_000);

  test("a red commit may delete a test file only when every case in it is recorded as superseded", () => {
    const OLD = `import { expect, test } from "bun:test";\ntest("old", () => { expect(1).toBe(1); });\n`;
    const run = (record: string | undefined): string[] => {
      const repo = repository();
      repo.commit({ "old.test.ts": OLD }, "old");
      rmSync(join(repo.dir, "old.test.ts"));
      const red = repo.commit({ "sum.test.ts": RED_TEST, ...(record === undefined ? {} : { "superseded-tests.json": record }) }, "red");
      repo.commit({ "sum.ts": "export const sum = (a: number, b: number): number => a + b;\n" }, "green");
      const lines: string[] = [];
      main([red, "HEAD", "--repo", repo.dir], (l) => lines.push(l));
      return lines;
    };
    expect(run(undefined)).toContain('FAIL scope: the red commit deletes old.test.ts, whose case "old" no record in superseded-tests.json supersedes');
    const recorded = run(JSON.stringify([{ file: "old.test.ts", case: "old", successor: null, reason: "replaced by sum" }]));
    expect(recorded.at(-1)).toBe("PASS red-first check");
  }, 60_000);

  test("reports a usage error for an unknown commit", () => {
    const repo = repository();
    const lines: string[] = [];
    expect(main(["nope", "--repo", repo.dir], (l) => lines.push(l))).toBe(2);
    expect(lines[0]).toBe("error: no such commit: nope");
  });
});
