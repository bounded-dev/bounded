import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  FORBIDDEN_MIN_LENGTH,
  forbiddenLines,
  parseJUnitReport,
  readStderrReport,
  SanitizeError,
  type SanitizedResult,
  sanitizeBunRun,
  sanitizeLegacyJsonRun,
  sanitizeMessage,
  TIMEOUT_MESSAGE,
  UNHANDLED_NAME,
} from "./sanitize-test-output.ts";

// Fixtures are REAL `bun test --reporter=junit --reporter-outfile=…` runs
// (bun 1.3.14, NO_COLOR=1), captured from throwaway projects whose test files
// are kept beside them in `sources/` (as `.txt`, so no runner collects them).
// Only two things were rewritten after capture: the fixture's absolute
// directory became `/home/dev/project`, and the machine's host name `ci-host`.
//
//   failing    two test files: assertion diffs, a throw inside the
//              implementation, console output before a failure (including a
//              line that imitates an error header and a code frame), a custom
//              expect message, a thrown string, a multi-line message with a
//              path, a toThrow mismatch, an async rejection, a timeout,
//              nested describes, a skip and a todo, and a describe name that
//              needs XML escaping.
//   passing    passes, a skip and a todo.
//   unhandled  a test file whose import cannot be resolved, one that throws
//              at module scope, and one healthy test.
const TESTDATA = join(import.meta.dirname, "testdata", "bun-junit");
interface Scenario {
  readonly xml: string;
  readonly stderr: string;
  readonly testSources: string[];
  readonly testPaths: string[];
}
const scenario = (name: string): Scenario => {
  const dir = join(TESTDATA, name);
  return {
    xml: readFileSync(join(dir, "report.xml"), "utf8"),
    stderr: readFileSync(join(dir, "stderr.txt"), "utf8"),
    testSources: readdirSync(join(dir, "sources")).filter((f) => f.includes(".test."))
      .map((f) => readFileSync(join(dir, "sources", f), "utf8")),
    testPaths: readdirSync(join(dir, "sources")).filter((f) => f.includes(".test."))
      .map((f) => `contexts/pm/src/domain/${f.replace(/\.txt$/, "")}`),
  };
};
const FAILING = scenario("failing");
const PASSING = scenario("passing");
const UNHANDLED = scenario("unhandled");

/** The machine root the captures were rewritten to. */
const ROOTS = ["/home/dev/project"];
const run = (s: Scenario, withForbidden = true): SanitizedResult[] =>
  sanitizeBunRun(s.xml, s.stderr, {
    forbidden: withForbidden ? forbiddenLines(s.testSources) : new Set(),
    pathRoots: ROOTS,
    testPaths: s.testPaths,
  });
const blob = (results: readonly SanitizedResult[]): string => results.map((r) => `${r.name}\n${r.message ?? ""}`).join("\n");

/** THE property: no line of any test file, of the forbidden length or more,
 *  survives — whatever bun printed. */
function expectNoTestSource(output: string, sources: readonly string[]): void {
  for (const source of sources) {
    for (const line of source.split("\n").map((l) => l.trim()).filter((l) => l.length >= FORBIDDEN_MIN_LENGTH)) {
      expect(output, line).not.toContain(line);
    }
  }
}

describe("parseJUnitReport (real reports)", () => {
  test("names join the describe blocks with ' > ', never the file's path; statuses map exactly", () => {
    const cases = parseJUnitReport(FAILING.xml);
    expect(cases.map((c) => [c.name, c.status])).toEqual([
      ['Note <parse> & "quotes" > implementation throws', "failed"],
      ['Note <parse> & "quotes" > console.error then fail', "failed"],
      ['Note <parse> & "quotes" > custom message', "failed"],
      ['Note <parse> & "quotes" > throws a string', "failed"],
      ['Note <parse> & "quotes" > multi-line error message', "failed"],
      ['Note <parse> & "quotes" > toThrow mismatch', "failed"],
      ['Note <parse> & "quotes" > rejects async', "failed"],
      ['Note <parse> & "quotes" > timeout', "failed"],
      ["NoteText > accepts a short note", "passed"],
      ["NoteText > rejects an empty note", "failed"],
      ["NoteText > equality > equal notes are equal", "failed"],
      ["NoteText > equality > skipped one", "skipped"],
      ["NoteText > equality > todo one", "todo"],
      ["NoteText > throws inside the implementation", "failed"],
      ["top-level passes", "passed"],
    ]);
    expect(cases.find((c) => c.name.endsWith("> timeout"))?.failureType).toBe("TimeoutError");
  });

  test("a file that failed to load has no entry in the report at all", () => {
    expect(parseJUnitReport(UNHANDLED.xml).map((c) => c.name)).toEqual(["a healthy test"]);
  });

  test("text nodes, CDATA, comments and unknown elements are never read", () => {
    const xml = [
      '<?xml version="1.0"?>',
      "<testsuites><!-- <testcase name=\"comment\"/> -->",
      '<testsuite name="/abs/secret/file.test.ts">',
      '<testcase name="t" file="/abs/secret/file.test.ts" line="3">',
      "<system-out>const secretSource = 1;</system-out>",
      "<failure type=\"AssertionError\"><![CDATA[<testcase name=\"cdata\"/> expect(secretSource)]]></failure>",
      "</testcase></testsuite></testsuites>",
    ].join("\n");
    const cases = parseJUnitReport(xml);
    expect(cases).toEqual([{ name: "t", status: "failed", failureType: "AssertionError" }]);
    expect(JSON.stringify(cases)).not.toContain("secret");
  });

  test("entities decode once, including numeric ones", () => {
    const xml = '<testsuites><testsuite name="f"><testsuite name="a &amp; b &#60;c&#x3e;"><testcase name="&quot;q&apos;" /></testsuite></testsuite></testsuites>';
    expect(parseJUnitReport(xml)[0]?.name).toBe("a & b <c> > \"q'");
  });

  test("anything that is not a JUnit report is refused", () => {
    expect(() => parseJUnitReport("")).toThrow(SanitizeError);
    expect(() => parseJUnitReport('{"testResults":[]}')).toThrow(SanitizeError);
    expect(parseJUnitReport('<testsuites name="bun test" tests="0"></testsuites>')).toEqual([]);
  });
});

describe("sanitizeBunRun (real failing run)", () => {
  const results = run(FAILING);
  const message = (suffix: string) => results.find((r) => r.name.endsWith(suffix))?.message;

  test("keeps the error name, its text and the expected/received diff", () => {
    expect(message("> rejects an empty note")).toBe('error: expect(received).toBe(expected)\nExpected: "hidden-oracle-value"\nReceived: ""');
    expect(message("> custom message")).toBe("error: should be the magic secret number\nExpected: 4\nReceived: 3");
    expect(message("> throws inside the implementation")).toBe("TypeError: Cannot read properties of undefined (reading 'value')");
    expect(message("> rejects async")).toBe("RangeError: async-range");
    expect(message("> equal notes are equal")).toContain('-   "a": 2,');
  });

  test("the red gate's reachability signal survives: the NotImplementedError text", () => {
    expect(message("> implementation throws")).toBe("error: Not implemented: parseNote");
  });

  test("a timeout gets fixed text", () => {
    expect(message("> timeout")).toBe(TIMEOUT_MESSAGE);
  });

  test("a slash-led value outside every machine root is the builder's data, and stays", () => {
    expect(message("> multi-line error message")).toBe("error: first line\nsecond line with /abs/path/file.ts:3:4");
  });

  test("console output before a failure never survives, even when it imitates an error header or a frame", () => {
    expect(FAILING.stderr).toContain("leaked-console-error-line");
    expect(message("> console.error then fail")).toBe(
      'error: expect(received).toContain(expected)\nExpected to contain: "gamma-secret"\nReceived: [ "alpha", "beta" ]');
    expect(blob(results)).not.toContain("leaked-console-error-line");
    expect(blob(results)).not.toContain("fakeFrame");
  });

  test("no test source line, frame, caret, stack or path survives — with or without the forbidden set", () => {
    for (const output of [blob(results), blob(run(FAILING, false))]) {
      expectNoTestSource(output, FAILING.testSources);
      expect(output).not.toMatch(/^\s*\d+\s*\|/m);
      expect(output).not.toMatch(/^\s*\^\s*$/m);
      expect(output).not.toMatch(/^\s*at\s/m);
      expect(output).not.toContain("/home/dev");
      expect(output).not.toContain(".test.ts");
      expect(output).not.toContain("(fail)");
    }
  });

  test("the raw capture really did contain what was removed", () => {
    expect(FAILING.stderr).toMatch(/^12 \|\s+expect\(secretLocal\.text\)\.toBe\(SECRET_EXPECTED\);$/m);
    expect(FAILING.stderr).toContain("/home/dev/project/contexts/pm/src/domain/note-text.test.ts:12:30");
  });
});

describe("sanitizeBunRun (real passing and unhandled runs)", () => {
  test("a passing run: every status, no message", () => {
    expect(run(PASSING)).toEqual([
      { name: "ProjectName > accepts a name", status: "passed" },
      { name: "ProjectName > parse > trims whitespace", status: "passed" },
      { name: "ProjectName > parse > rejects emoji", status: "skipped" },
      { name: "ProjectName > parse > normalises unicode", status: "todo" },
    ]);
  });

  test("each error outside a test becomes one failed result, its frame and paths removed", () => {
    const results = run(UNHANDLED);
    expect(results).toEqual([
      { name: "a healthy test", status: "passed" },
      { name: UNHANDLED_NAME, status: "failed", message: "error: Cannot find module './does-not-exist.ts' from '[path]'" },
      { name: UNHANDLED_NAME, status: "failed", message: "error: module failed while loading top-level-secret" },
    ]);
    expectNoTestSource(blob(results), UNHANDLED.testSources);
  });

  test("an error count the blocks do not account for still fails the run", () => {
    const results = sanitizeBunRun(PASSING.xml, " 2 pass\n 0 fail\n 1 error\n");
    expect(results.at(-1)).toMatchObject({ name: UNHANDLED_NAME, status: "failed" });
  });
});

describe("adversarial console output", () => {
  const xml = (names: readonly string[]) =>
    `<testsuites><testsuite name="x.test.ts">${names.map((n) => `<testcase name="${n}"><failure type="AssertionError" /></testcase>`).join("")}</testsuite></testsuites>`;

  test("without a code frame, the last error header wins over console noise before it", () => {
    const stderr = ["error: from console.error", "noise line", "error: the real failure", "(fail) t [1.00ms]"].join("\n");
    expect(sanitizeBunRun(xml(["t"]), stderr)[0]?.message).toBe("error: the real failure");
  });

  test("a message that quotes a test line loses that line, and only that line", () => {
    const source = 'test("t", () => {\n  const secret = computeOracle("k");\n});';
    const stderr = ["1 | x", "    ^", "error: boom", 'const secret = computeOracle("k");', "detail kept", "(fail) t [1.00ms]"].join("\n");
    expect(sanitizeBunRun(xml(["t"]), stderr, forbiddenLines([source]))[0]?.message).toBe("error: boom\ndetail kept");
  });

  test("a quoted test line cannot hide behind a path: redaction happens before and after the check", () => {
    const source = "  expect(read('/fixtures/a.json')).toEqual(oracle);";
    const stderr = ["  ^", "error: x", "expect(read('/fixtures/a.json')).toEqual(oracle);", "(fail) t [1.00ms]"].join("\n");
    expect(sanitizeBunRun(xml(["t"]), stderr, forbiddenLines([source]))[0]?.message).toBe("error: x");
  });

  test("ANSI colour, Windows and file:// paths are removed", () => {
    const stderr = ["\u001b[31m    ^\u001b[0m", "\u001b[31merror\u001b[0m: at C:\\Users\\dev\\p\\x.test.ts and file:///home/dev/x.ts:1:2", "(fail) t [1.00ms]"].join("\n");
    const message = sanitizeBunRun(xml(["t"]), stderr, { pathRoots: ["/home/dev"] })[0]?.message ?? "";
    expect(message).toBe("error: at [path] and [path]");
  });

  test("two tests with one name get their own messages, in order", () => {
    const stderr = ["  ^", "error: first", "(fail) same [1.00ms]", "  ^", "error: second", "(fail) same [2.00ms]"].join("\n");
    expect(sanitizeBunRun(xml(["same", "same"]), stderr).map((r) => r.message)).toEqual(["error: first", "error: second"]);
  });

  test("a failure whose block is missing still fails, with no message", () => {
    expect(sanitizeBunRun(xml(["t"]), "")).toEqual([{ name: "t", status: "failed" }]);
  });

  test("a huge message is bounded", () => {
    const stderr = ["  ^", "error: big", ...Array.from({ length: 500 }, (_, i) => `line ${i}`), "(fail) t [1.00ms]"].join("\n");
    const message = sanitizeBunRun(xml(["t"]), stderr)[0]?.message ?? "";
    expect(message.split("\n").length).toBeLessThanOrEqual(41);
    expect(message.endsWith("…")).toBe(true);
  });

  test("the stderr reader keys failures by bun's full name and counts errors", () => {
    const report = readStderrReport(FAILING.stderr);
    expect([...report.failures.keys()]).toContain("NoteText > equality > equal notes are equal");
    expect(readStderrReport(UNHANDLED.stderr)).toMatchObject({ errorCount: 2 });
    expect(readStderrReport(UNHANDLED.stderr).unhandled).toHaveLength(2);
  });
});

describe("review repros (hostile fixtures)", () => {
  const xml = (cases: readonly [string, boolean][]) =>
    `<testsuites><testsuite name="f.test.ts">${cases.map(([n, failed]) =>
      failed ? `<testcase name="${n}"><failure type="AssertionError" /></testcase>` : `<testcase name="${n}" />`).join("")}</testsuite></testsuites>`;

  test("h3: console output that fakes another test's failure marker cannot move text onto it", () => {
    // A passing test prints an error header and `(fail) target`; the real
    // failure of `target` follows. Neither the fixture data nor the fake is
    // attributed: the fake has no duration, and a marker is believed only
    // for a test the JUnit report says failed, as often as it says.
    const stderr = [
      "f.test.ts:",
      'error: dump {"id":"fixture-id-value","payload":"hidden-payload"}',
      "(fail) target",
      "(pass) logs [0.10ms]",
      "4 | test(\"target\", () => { expect(1).toBe(2); });",
      "                                     ^",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: 2",
      "Received: 1",
      "",
      "      at <anonymous> (/home/dev/project/f.test.ts:4:38)",
      "(fail) target [0.20ms]",
    ].join("\n");
    const results = sanitizeBunRun(xml([["logs", false], ["target", true]]), stderr, { pathRoots: ROOTS });
    expect(results).toEqual([
      { name: "logs", status: "passed" },
      { name: "target", status: "failed", message: "error: expect(received).toBe(expected)\nExpected: 2\nReceived: 1" },
    ]);
    expect(JSON.stringify(results)).not.toContain("hidden-payload");
  });

  test("h3: a marker with a duration for a test that passed is text, not a boundary", () => {
    const stderr = ["  ^", "error: real", "(fail) logs [1.00ms]", "(fail) target [1.00ms]"].join("\n");
    const results = sanitizeBunRun(xml([["logs", false], ["target", true]]), stderr);
    expect(results[1]?.message).toBe("error: real");
  });

  test("h2: slash-led values in an assertion are kept; machine paths and test file names are not", () => {
    const ctx = { pathRoots: ["/home/dev/project", "/tmp/x"], testPaths: ["contexts/pm/src/domain/note.test.ts"] };
    expect(sanitizeMessage('Expected: "/api/projects/list"\nReceived: "/api/projects/create"', ctx))
      .toBe('Expected: "/api/projects/list"\nReceived: "/api/projects/create"');
    expect(sanitizeMessage("Expected: /regexFromTestSource/", ctx)).toBe("Expected: /regexFromTestSource/");
    expect(sanitizeMessage("cannot open /home/dev/project/contexts/pm/src/x.ts: EACCES", ctx)).toBe("cannot open [path]: EACCES");
    expect(sanitizeMessage("wrote /tmp/x/scratch/a.json", ctx)).toBe("wrote [path]");
    expect(sanitizeMessage("while running contexts/pm/src/domain/note.test.ts:12:3 and note.test.ts", ctx)).toBe("while running [path] and [path]");
    expect(sanitizeMessage("loaded /elsewhere/contexts/pm/src/domain/note.test.ts", ctx)).toBe("loaded [path]");
  });
});

describe("sanitizeMessage and forbiddenLines (units)", () => {
  test("redacts absolute, relative and file:// paths and drops frames", () => {
    const msg = [
      "AssertionError: expected 1 to be 2",
      "    at /Users/someone/secret/proj/src/thing.test.ts:12:3",
      "    at file:///Users/someone/node_modules/x/dist/x.js:1:1",
      " ❯ ../../secret/src/thing.test.ts:12:3",
    ].join("\n");
    expect(sanitizeMessage(msg)).toBe("AssertionError: expected 1 to be 2");
  });

  test("short lines are never forbidden (they carry no source worth hiding)", () => {
    expect([...forbiddenLines(["});\n  x = 1;\n  expect(total).toBe(7);"])]).toEqual(["expect(total).toBe(7);"]);
  });
});

describe("TRANSITIONAL: the retired JSON report", () => {
  test("names, statuses and sanitized messages", () => {
    const json = JSON.stringify({
      testResults: [
        { assertionResults: [
          { ancestorTitles: ["a"], title: "b", status: "passed" },
          { fullName: "c", status: "failed", failureMessages: ["Error: Not implemented: X.y\n    at /abs/x.ts:1:2\n  3| secret()"] },
        ] },
        { assertionResults: [], status: "failed", message: "Error: cannot load /abs/file.ts" },
      ],
    });
    expect(sanitizeLegacyJsonRun(json, { pathRoots: ["/abs"] })).toEqual([
      { name: "a b", status: "passed" },
      { name: "c", status: "failed", message: "Error: Not implemented: X.y" },
      { name: UNHANDLED_NAME, status: "failed", message: "Error: cannot load [path]" },
    ]);
  });

  test("invalid input is refused", () => {
    expect(() => sanitizeLegacyJsonRun("not json {")).toThrow(SanitizeError);
    expect(() => sanitizeLegacyJsonRun('{"foo":1}')).toThrow(SanitizeError);
  });
});
