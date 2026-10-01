import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  type CommandRunner,
  failureNames,
  formatRunTests,
  hasUnhandledError,
  IGNORE_HARNESS_STATE,
  NO_REPORT,
  NO_TEST_FILES,
  TEST_PRELOAD,
  testEnvironment,
  repeatedFailureNudge,
  type RunTestsResult,
  runTests,
  runTestsGate,
  summarizeResults,
  testCommand,
  testSources,
  UNHANDLED_ERROR_NOTE,
} from "./run-tests.ts";
import { UNHANDLED_NAME } from "./sanitize-test-output.ts";
import { readGuardLog } from "../../../src/guard-log.ts";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import { makeTempProject, type TempProject } from "../../../test/support/temp-project.ts";

// Real `bun test --reporter=junit` runs, captured from throwaway fixture
// projects (see sanitize-test-output.test.ts for how and what they contain).
const TESTDATA = join(import.meta.dirname, "testdata", "bun-junit");
const scenario = (name: string) => ({
  xml: readFileSync(join(TESTDATA, name, "report.xml"), "utf8"),
  stderr: readFileSync(join(TESTDATA, name, "stderr.txt"), "utf8"),
  code: Number(readFileSync(join(TESTDATA, name, "exit-code.txt"), "utf8")),
  sources: Object.fromEntries(readdirSync(join(TESTDATA, name, "sources"))
    .map((file) => [file.replace(/\.txt$/, ""), readFileSync(join(TESTDATA, name, "sources", file), "utf8")])),
});
const FAILING = scenario("failing");
const PASSING = scenario("passing");
const UNHANDLED = scenario("unhandled");

/** A CommandRunner that plays bun: it writes `xml` to the JUnit outfile its
 *  args name, and returns the captured console output. */
function bunRunner(run: { xml: string; stderr: string }, code: number | null): CommandRunner {
  return async (_command, args) => {
    const outfile = args.find((a) => a.startsWith("--reporter-outfile="))?.slice("--reporter-outfile=".length);
    if (outfile !== undefined) writeFileSync(outfile, run.xml);
    return { stdout: "bun test v1.3.14\n", stderr: run.stderr, code };
  };
}

/** A CommandRunner that writes no report at all. */
function silentRunner(stdout: string, stderr = "", code: number | null = 1): CommandRunner {
  return async () => ({ stdout, stderr, code });
}

const projects: TempProject[] = [];
afterAll(() => projects.forEach((p) => p.cleanup()));
function project(files: Record<string, string> = {}): string {
  const p = makeTempProject(files, { prefix: "run-tests-" });
  projects.push(p);
  return p.dir;
}
/** A project holding the fixture's own test sources, at the paths bun ran them from. */
function projectWith(run: { sources: Record<string, string> }): string {
  return project(Object.fromEntries(Object.entries(run.sources)
    .map(([file, text]) => [`contexts/pm/src/domain/${file}`, text])));
}

describe("the suite invocation (ADR 2026-062)", () => {
  test("bun's runner, its JUnit reporter into the given file, harness state ignored", () => {
    expect(testCommand("/tmp/r/report.xml")).toEqual({
      command: "bun",
      args: ["test", "--reporter=junit", "--reporter-outfile=/tmp/r/report.xml", IGNORE_HARNESS_STATE, `--preload=${TEST_PRELOAD}`],
    });
  });

  test("runTests passes a fresh outfile outside the project and removes it afterwards", async () => {
    const dir = project();
    let seen: string | undefined;
    await runTests(dir, {
      run: async (command, args, cwd) => {
        expect(command).toBe("bun");
        expect(cwd).toBe(dir);
        seen = args.find((a) => a.startsWith("--reporter-outfile="))!.slice("--reporter-outfile=".length);
        writeFileSync(seen, PASSING.xml);
        return { stdout: "", stderr: PASSING.stderr, code: 0 };
      },
    });
    expect(seen!.startsWith(dir)).toBe(false);
    expect(() => readFileSync(seen!)).toThrow();
  });
});

describe("runTests on real bun output", () => {
  test("a failing run: counts, names from the report, messages from the console, not ok", async () => {
    const r = await runTests(projectWith(FAILING), { run: bunRunner(FAILING, FAILING.code) });
    expect(r).toMatchObject({ ok: false, total: 15, passed: 2, failed: 11, skipped: 2 });
    expect(r.blocked).toBeUndefined();
    const byName = new Map(r.results.map((x) => [x.name, x]));
    expect(byName.get("NoteText > rejects an empty note")?.message)
      .toBe('error: expect(received).toBe(expected)\nExpected: "hidden-oracle-value"\nReceived: ""');
    expect(byName.get('Note <parse> & "quotes" > implementation throws')?.message).toBe("error: Not implemented: parseNote");
  });

  test("a failing run leaks no test source line, path, frame or console output", async () => {
    const r = await runTests(projectWith(FAILING), { run: bunRunner(FAILING, FAILING.code) });
    const blob = r.results.map((x) => `${x.name}\n${x.message ?? ""}`).join("\n");
    for (const [file, text] of Object.entries(FAILING.sources)) {
      if (!file.includes(".test.")) continue;
      for (const line of text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 8)) {
        expect(blob, `${file}: ${line}`).not.toContain(line);
      }
    }
    for (const leak of ["/home/dev", ".test.ts", " | ", "SECRET_LOG", "leaked-console-error-line", "fakeFrame", "at <anonymous>"]) {
      expect(blob).not.toContain(leak);
    }
  });

  test("a passing run is ok, with skips and todos counted as skipped", async () => {
    const r = await runTests(projectWith(PASSING), { run: bunRunner(PASSING, PASSING.code) });
    expect(r).toMatchObject({ ok: true, total: 4, passed: 2, failed: 0, skipped: 2 });
    for (const x of r.results) expect(x.message).toBeUndefined();
  });

  test("a file that fails to load, or throws at module scope, is a failed result — never green", async () => {
    const r = await runTests(projectWith(UNHANDLED), { run: bunRunner(UNHANDLED, UNHANDLED.code) });
    expect(r.ok).toBe(false);
    expect(r.passed).toBe(1);
    const outside = r.results.filter((x) => x.name === UNHANDLED_NAME);
    expect(outside).toHaveLength(2);
    expect(outside[0]?.message).toBe("error: Cannot find module './does-not-exist.ts' from '[path]'");
    expect(outside[1]?.message).toBe("error: module failed while loading top-level-secret");
    expect(JSON.stringify(r)).not.toContain("hiddenTopLevelValue");
  });
});

describe("the forbidden lines come from the project's test files", () => {
  test("every file bun would run and every composed test-side suffix, never an implementation", () => {
    const dir = project({
      "contexts/pm/src/a.test.ts": "A_TEST",
      "contexts/pm/src/b.spec.tsx": "B_SPEC",
      "contexts/pm/src/c_test_d.js": "C_UNDERSCORE",
      "contexts/pm/src/e.store.test-support.ts": "E_SUPPORT",
      "contexts/pm/src/__snapshots__/a.test.ts.snap": "S_SNAPSHOT",
      "contexts/pm/src/f.ts": "F_IMPLEMENTATION",
      "node_modules/dep/g.test.ts": "G_DEPENDENCY",
      ".bounded/shadow-red/h.test.ts": "H_SHADOW",
    });
    // The composed test-side suffixes join bun's pattern (the ts pack's `.test-support.ts`).
    writeProjectPacks(dir, ["ts"]);
    // Snapshots are test-side too: they hold the expected values (`.test.ts.snap`).
    expect(testSources(dir).sort()).toEqual(["A_TEST", "B_SPEC", "C_UNDERSCORE", "E_SUPPORT", "S_SNAPSHOT"]);
    // Without a readable composition, bun's own pattern still applies.
    rmSync(join(dir, ".bounded", "composed-packs.json"));
    expect(testSources(dir).sort()).toEqual(["A_TEST", "B_SPEC", "C_UNDERSCORE"]);
  });

  test("a test that throws its own source still cannot show it", async () => {
    const source = [
      'import { test } from "bun:test";',
      'test("dumps itself", () => {',
      '  const oracle = computeTheSecretOracleValue(42);',
      "  throw new Error(require('fs').readFileSync(import.meta.path, 'utf8'));",
      "});",
    ].join("\n");
    const dir = project({ "contexts/pm/src/self.test.ts": source });
    const xml = '<?xml version="1.0"?><testsuites><testsuite name="contexts/pm/src/self.test.ts">' +
      '<testcase name="dumps itself"><failure type="AssertionError" /></testcase></testsuite></testsuites>';
    const stderr = ["contexts/pm/src/self.test.ts:", "4 |   throw …", "      ^", `error: ${source}`, "      at <anonymous> (/x/self.test.ts:4:9)", "(fail) dumps itself [0.10ms]", ""].join("\n");
    const r = await runTests(dir, { run: bunRunner({ xml, stderr }, 1) });
    const message = r.results[0]?.message ?? "";
    expect(message).not.toContain("computeTheSecretOracleValue");
    expect(message).not.toContain("readFileSync");
  });
});

// --- unhandled errors (dogfood Run 29) ---------------------------------------
// A suite can exit non-zero with every test passing: an error bun reports
// outside every test. A runner that only tallies pass/fail calls it green.

describe("runTests (0 failed, non-zero exit)", () => {
  test("a passing report with a non-zero exit is NOT ok and carries the fixed note", async () => {
    const r = await runTests(project(), { run: bunRunner({ xml: PASSING.xml, stderr: "" }, 1) });
    expect(r).toMatchObject({ ok: false, failed: 0, unhandled: UNHANDLED_ERROR_NOTE });
    expect(r.blocked).toBeUndefined();
    expect(r.unhandled).not.toContain("/");
  });

  test("a clean pass (zero exit) is untouched — no false positive", async () => {
    const r = await runTests(project(), { run: bunRunner(PASSING, 0) });
    expect(r.ok).toBe(true);
    expect(r.unhandled).toBeUndefined();
  });

  test("hasUnhandledError: only 0-failed AND non-zero exit AND tests ran", () => {
    expect(hasUnhandledError(1, 0, 5)).toBe(true);
    expect(hasUnhandledError(0, 0, 5)).toBe(false);
    expect(hasUnhandledError(1, 2, 5)).toBe(false);
    expect(hasUnhandledError(1, 0, 0)).toBe(false);
    expect(hasUnhandledError(null, 0, 5)).toBe(true);
  });

  test("formatRunTests names the unhandled error rather than reading green", async () => {
    const r = await runTests(project(), { run: bunRunner({ xml: PASSING.xml, stderr: "" }, 1) });
    expect(formatRunTests(r)).toContain("UNHANDLED ERROR");
  });
});

describe("runTests (suite could not run)", () => {
  test("no test files: fixed text", async () => {
    const stderr = 'error: 0 test files matching **{.test,.spec,_test_,_spec_}.{js,ts,jsx,tsx} in --cwd="/Users/secret/proj"';
    const r = await runTests(project(), { run: silentRunner("bun test v1.3.14\n", stderr) });
    expect(r).toMatchObject({ ok: false, results: [], blocked: NO_TEST_FILES });
  });

  test("h4: a run that ends without a report shows fixed text only — none of what it printed", async () => {
    // Captured from the review's h4 repro: a failing test, then a test that
    // dumps a fixture and a source-shaped line and calls process.exit(3).
    const stderr = [
      "g.test.ts:",
      "3 | test(\"a\", () => { expect(1).toBe(2); });",
      "                                   ^",
      "error: expect(received).toBe(expected)",
      "Expected: 2",
      "Received: 1",
      "(fail) a [0.10ms]",
      'dump {"id":"fixture-id-value","payload":"hidden-payload"}',
      "  multi",
      "  const hiddenExpr = compute(fixture) + 1;",
    ].join("\n");
    const r = await runTests(project(), { run: silentRunner("", stderr, 3) });
    expect(r.blocked).toBe(`${NO_REPORT} (exit code 3)`);
    expect(formatRunTests(r)).not.toMatch(/hidden|fixture|compute/);
  });
});

describe("summarizeResults", () => {
  test("counts by status bucket", () => {
    const s = summarizeResults([
      { name: "a", status: "passed" },
      { name: "b", status: "failed", message: "boom" },
      { name: "c", status: "skipped" },
      { name: "d", status: "todo" },
    ]);
    expect(s).toEqual({ total: 4, passed: 1, failed: 1, skipped: 2 });
  });
});

describe("formatRunTests", () => {
  test("failing run lists each failure with its message", async () => {
    const text = formatRunTests(await runTests(projectWith(FAILING), { run: bunRunner(FAILING, 1) }));
    expect(text).toContain("✗ NoteText > rejects an empty note");
    expect(text).toContain('Expected: "hidden-oracle-value"');
  });

  test("blocked run explains the suite could not run", async () => {
    const text = formatRunTests(await runTests(project(), { run: silentRunner("nope", "boom", 1) }));
    expect(text.toLowerCase()).toContain("could not");
  });
});

// --- repeated-failure detection (dogfood Run 4) -------------------------------

describe("repeatedFailureNudge", () => {
  const A = ["idempotency reuse", "failed call does not consume id"];

  test("first and second sightings are not stuck; the third is", () => {
    expect(repeatedFailureNudge([], A)).toBeUndefined();
    expect(repeatedFailureNudge([A], A)).toBeUndefined();
    const n = repeatedFailureNudge([A, A], A);
    expect(n).toContain("3rd consecutive run");
    expect(n).toContain("DISPUTE");
  });

  test("order does not matter; progress, a different run or a green run resets", () => {
    expect(repeatedFailureNudge([[...A].reverse(), A], A)).toBeDefined();
    expect(repeatedFailureNudge([A, A], ["something else"])).toBeUndefined();
    expect(repeatedFailureNudge([A, A], [A[0]!])).toBeUndefined();
    expect(repeatedFailureNudge([A, ["other"], A], A)).toBeUndefined();
    expect(repeatedFailureNudge([A, A], [])).toBeUndefined();
  });

  test("the nudge never names test source, only the count and the protocol", () => {
    const n = repeatedFailureNudge([A, A, A], A)!;
    expect(n).toContain("4th consecutive run");
    expect(n).toMatch(/path gate|will refuse|cannot read/i);
  });
});

describe("failureNames", () => {
  test("extracts only failing test names, in report order", () => {
    const r = {
      ok: false, total: 3, passed: 1, failed: 2, skipped: 0,
      results: [
        { name: "a", status: "passed" },
        { name: "b", status: "failed", message: "AssertionError" },
        { name: "c", status: "failed", message: "AssertionError" },
      ],
    } as RunTestsResult;
    expect(failureNames(r)).toEqual(["b", "c"]);
  });
});

// --- real bun (skipped, with the reason logged, where bun is absent) ----------

const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" });
const HAS_BUN = bunVersion.status === 0;
if (!HAS_BUN) console.warn("run-tests.test.ts: skipping the real-bun tests — `bun` is not on PATH");

describe.skipIf(!HAS_BUN)("real bun", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const write = (dir: string, path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };

  test("the live suite runs; the shadow under .bounded/ is not collected; the view is sanitized", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-tests-bun-"));
    dirs.push(dir);
    write(dir, "package.json", '{"name":"probe","private":true,"type":"module"}\n');
    const failing = 'test("fails", () => { const hiddenOracle = "the-hidden-oracle"; expect(1).toBe(hiddenOracle.length); });';
    write(dir, "contexts/pm/src/live.test.ts",
      `import { expect, test } from "bun:test";\ntest("live", () => { expect(1).toBe(1); });\n${failing}\n`);
    write(dir, ".bounded/shadow-red/contexts/pm/src/live.test.ts",
      'import { expect, test } from "bun:test";\ntest("shadow", () => { expect(1).toBe(2); });\n');
    const result = await runTests(dir);
    expect(result.blocked).toBeUndefined();
    expect(result.results.map((r) => r.name)).toEqual(["live", "fails"]);
    const message = result.results[1]?.message ?? "";
    expect(message).toContain("Expected: 17");
    expect(message).not.toContain(dir);
    expect(message).not.toContain("hiddenOracle");
  });

  test("inside the shadow itself, the shadow's own tests do run", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-tests-bun-shadow-"));
    dirs.push(dir);
    const shadow = join(dir, ".bounded", "shadow-red");
    write(shadow, "package.json", '{"name":"probe","private":true,"type":"module"}\n');
    write(shadow, "a.test.ts", 'import { expect, test } from "bun:test";\ntest("in shadow", () => { expect(1).toBe(1); });\n');
    expect((await runTests(shadow)).results.map((r) => r.name)).toEqual(["in shadow"]);
  });

  /** A temp project holding one of the review's repro directories
   *  (testdata/review/<name>/*.txt, written back under their real names). */
  function repro(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `run-tests-review-${name}-`));
    dirs.push(dir);
    write(dir, "package.json", '{"name":"repro","private":true,"type":"module"}\n');
    const from = join(import.meta.dirname, "testdata", "review", name);
    for (const file of readdirSync(from)) write(dir, file.replace(/\.txt$/, ""), readFileSync(join(from, file), "utf8"));
    return dir;
  }
  const allText = (r: RunTestsResult): string => `${formatRunTests(r)}\n${JSON.stringify(r)}`;
  const expectNoLineOf = (text: string, dir: string, files: readonly string[]) => {
    for (const file of files) {
      for (const line of readFileSync(join(dir, file), "utf8").split("\n").map((l) => l.trim()).filter((l) => l.length >= 8)) {
        expect(text, `${file}: ${line}`).not.toContain(line);
      }
    }
  };

  test("hostile: no test line, machine path, console line or snapshot write survives the real run", { timeout: 60_000 }, async () => {
    const dir = repro("hostile");
    const before = readFileSync(join(dir, "a.test.ts"), "utf8");
    const r = await runTests(dir);
    const text = allText(r);
    expectNoLineOf(text, dir, ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"]);
    for (const leak of [dir, realpathSync(dir), homedir(), "CONSOLE_SECRET_LINE", "CONSOLE_AFTER_CARET"]) {
      expect(text).not.toContain(leak);
    }
    // The inline snapshot mismatch never passes (b.test.ts's late throw can
    // make bun drop the case from the report), and CI=true stops bun
    // rewriting the test file.
    expect(r.results.find((x) => x.name === "grp > snapshot")?.status).not.toBe("passed");
    expect(readFileSync(join(dir, "a.test.ts"), "utf8")).toBe(before);
    // A slash-led value in an assertion is the builder's data and stays.
    const toThrow = r.results.find((x) => x.name === "grp > toThrow");
    if (toThrow !== undefined) expect(toThrow.message).toContain("/regexFromTestSource/");
  });

  test("h2: values survive, fixture data logged before a failure does not", { timeout: 60_000 }, async () => {
    const dir = repro("h2");
    const r = await runTests(dir);
    const text = allText(r);
    expect(r.results.find((x) => x.name === "route")?.message).toBe(
      'error: expect(received).toBe(expected)\nExpected: "/api/projects/list"\nReceived: "/api/projects/create"');
    for (const leak of ["secretlogged", "secret2", "secret4", "LOGGED"]) expect(text).not.toContain(leak);
    expectNoLineOf(text, dir, ["e.test.ts"]);
  });

  test("h3: a test that fakes another test's failure marker moves nothing onto it", { timeout: 60_000 }, async () => {
    const dir = repro("h3");
    const r = await runTests(dir);
    expect(r.results).toEqual([
      { name: "logs", status: "passed", file: "f.test.ts" },
      { name: "target", status: "failed", message: "error: expect(received).toBe(expected)\nExpected: 2\nReceived: 1", file: "f.test.ts" },
    ]);
  });

  test("h4: process.exit ends the run without a report; fixed text only", { timeout: 60_000 }, async () => {
    const dir = repro("h4");
    const r = await runTests(dir);
    expect(r.blocked).toBe(`${NO_REPORT} (exit code 3)`);
    expect(allText(r)).not.toMatch(/fixture|hidden|compute/);
  });

  test("snapshots are never written by a run: a missing file snapshot and an empty inline one both fail", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-tests-snap-"));
    dirs.push(dir);
    write(dir, "package.json", '{"name":"snap","private":true,"type":"module"}\n');
    write(dir, "s.test.ts", 'import { test, expect } from "bun:test";\ntest("snap", () => { expect({ total: 1 }).toMatchSnapshot(); });\n');
    const inline = 'import { test, expect } from "bun:test";\ntest("inline", () => { expect({ total: 1 }).toMatchInlineSnapshot(); });\n';
    write(dir, "i.test.ts", inline);
    const r = await runTests(dir);
    expect(r.results.map((x) => [x.name, x.status]).sort()).toEqual([["inline", "failed"], ["snap", "failed"]]);
    expect(readFileSync(join(dir, "i.test.ts"), "utf8")).toBe(inline);
    // bun 1.3.14 may create the snapshot file, but only its header: no value is written.
    const snap = join(dir, "__snapshots__", "s.test.ts.snap");
    if (existsSync(snap)) expect(readFileSync(snap, "utf8")).not.toContain("total");
  });

  test("a global bunfig in the home or config directory is not applied to the run", { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "run-tests-bunfig-"));
    dirs.push(dir);
    write(dir, "home/.bunfig.toml", `[test]\npreload = ["${join(dir, "evil.ts")}"]\n`);
    write(dir, "evil.ts", 'require("node:fs").writeFileSync(require("node:path").join(import.meta.dir, "EVIL_RAN"), "");\n');
    write(dir, "p/a.test.ts", 'import { test } from "bun:test";\ntest("t", () => {});\n');
    const env = testEnvironment({ ...process.env, HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "home") });
    const run = spawnSync("bun", ["test"], { cwd: join(dir, "p"), env, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(dir, "EVIL_RAN"))).toBe(false);
  });
});

describe("the suite's environment", () => {
  test("CI=true, colour off, and every inherited BUN_ variable dropped", () => {
    const env = testEnvironment({ PATH: "/bin", BUN_CONFIG_REGISTRY: "x", bun_options: "y", BUN_UPDATE_SNAPSHOTS: "1", CI: "false", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" });
  });
});

// --- the gate (ADR 2026-034) ----------------------------------------------------

describe("runTestsGate", () => {
  test("passing suite: PASS, counts in the detail, one pass event with no names", async () => {
    const dir = project();
    const r = await runTestsGate(dir, { run: bunRunner(PASSING, 0) });
    expect(r).toMatchObject({ code: 0, verdict: "pass" });
    expect(r.summary).toBe("2 passed, 0 failed, 2 skipped");
    expect(r.detail).toMatchObject({ ok: true, failed: 0, blocked: false, stuck: false, names: [] });
    expect(readGuardLog(dir)).toEqual([
      expect.objectContaining({ guard: "run_tests", verdict: "pass", detail: { names: [] } }),
    ]);
  });

  test("failing suite: BLOCK, the failing names logged, nothing from test source", async () => {
    const dir = projectWith(FAILING);
    const r = await runTestsGate(dir, { run: bunRunner(FAILING, 1) });
    expect(r).toMatchObject({ code: 1, verdict: "block" });
    expect(r.lines.join("\n")).toContain("✗ NoteText > rejects an empty note");
    expect(r.lines.join("\n")).not.toContain("/home/dev");
    const [event] = readGuardLog(dir);
    expect(event?.detail?.["names"]).toContain("NoteText > rejects an empty note");
  });

  test("the third identical failure set trips the nudge, from the log alone", async () => {
    const dir = project();
    const run = () => runTestsGate(dir, { run: bunRunner(FAILING, 1) });
    const first = await run();
    const second = await run();
    const third = await run();
    expect([first.detail["stuck"], second.detail["stuck"], third.detail["stuck"]]).toEqual([false, false, true]);
    expect(third.lines.join("\n")).toMatch(/3rd consecutive run .* you are not converging/);
  });

  test("a suite that passes every test but exits non-zero: BLOCK (unhandled)", async () => {
    const dir = project();
    const r = await runTestsGate(dir, { run: bunRunner({ xml: PASSING.xml, stderr: "" }, 1) });
    expect(r).toMatchObject({ code: 1, verdict: "block", summary: "suite raised an unhandled error" });
    expect(readGuardLog(dir)[0]?.detail?.["unhandled"]).toBe(true);
  });

  test("a suite that produces no report: ERROR, logged as such", async () => {
    const dir = project();
    const r = await runTestsGate(dir, { run: silentRunner("", "error: cannot start", 1) });
    expect(r).toMatchObject({ code: 2, verdict: "error", summary: "suite could not run" });
    expect(readGuardLog(dir)[0]).toMatchObject({ guard: "run_tests", verdict: "error" });
  });
});
