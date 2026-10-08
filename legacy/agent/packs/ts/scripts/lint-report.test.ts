import { describe, expect, test } from "vitest";
import type { ESLint, Linter } from "eslint";
import { formatProblems, toProblems } from "./lint-report.ts";

// lint-report is the one place contract-purity and lint-src agree on what a
// "problem" is. The gates share it precisely so they cannot drift apart, so
// what these tests pin is the shared contract: errors only, one greppable
// line per problem, paths relative to the project the gate ran in.

function message(partial: Partial<Linter.LintMessage>): Linter.LintMessage {
  return {
    ruleId: "bounded-ts/declaration-only",
    severity: 2,
    message: "a contract may only declare",
    line: 1,
    column: 1,
    ...partial,
  };
}

function result(filePath: string, messages: Linter.LintMessage[]): ESLint.LintResult {
  return {
    filePath,
    messages,
    suppressedMessages: [],
    errorCount: messages.filter((m) => m.severity === 2).length,
    fatalErrorCount: 0,
    warningCount: messages.filter((m) => m.severity === 1).length,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    usedDeprecatedRules: [],
  };
}

describe("toProblems", () => {
  test("carries the whole location and message through unchanged", () => {
    expect(
      toProblems([
        result("/proj/src/orders/orders.contract.ts", [
          message({ line: 12, column: 3, ruleId: "bounded-ts/no-naked-primitives", message: "naked string" }),
        ]),
      ]),
    ).toEqual([
      {
        filePath: "/proj/src/orders/orders.contract.ts",
        line: 12,
        column: 3,
        ruleId: "bounded-ts/no-naked-primitives",
        message: "naked string",
      },
    ]);
  });

  // "A warning that does not fail a gate is advice, and the gates do not give
  // advice." If a warning ever leaks into the list, a gate reports a problem
  // it will not fail on — the worst of both.
  test("drops warnings and keeps only errors", () => {
    const problems = toProblems([
      result("/proj/src/a.ts", [
        message({ severity: 1, ruleId: "warn-rule" }),
        message({ severity: 2, ruleId: "error-rule" }),
      ]),
    ]);
    expect(problems.map((p) => p.ruleId)).toEqual(["error-rule"]);
  });

  test("flattens across files, preserving reporter order", () => {
    const problems = toProblems([
      result("/proj/src/a.ts", [message({ line: 1 }), message({ line: 4 })]),
      result("/proj/src/b.ts", [message({ line: 2 })]),
    ]);
    expect(problems.map((p) => `${p.filePath}:${p.line}`)).toEqual([
      "/proj/src/a.ts:1",
      "/proj/src/a.ts:4",
      "/proj/src/b.ts:2",
    ]);
  });

  // A file ESLint could not parse reports with `ruleId: null`. That is still a
  // gate failure, so it needs a name a human can read in the output.
  test("a null ruleId (parse failure) is named <parse>", () => {
    const problems = toProblems([
      result("/proj/src/broken.ts", [message({ ruleId: null, message: "Parsing error: ')' expected." })]),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.ruleId).toBe("<parse>");
  });

  test("a clean run yields no problems", () => {
    expect(toProblems([result("/proj/src/a.ts", [])])).toEqual([]);
    expect(toProblems([])).toEqual([]);
  });
});

describe("formatProblems", () => {
  test("renders path:line:col, rule, message with the path relative to cwd", () => {
    expect(
      formatProblems(
        [
          result("/proj/src/orders/orders.contract.ts", [
            message({ line: 12, column: 3, ruleId: "bounded-ts/declaration-only", message: "no bodies" }),
          ]),
        ],
        "/proj",
      ),
    ).toEqual(["src/orders/orders.contract.ts:12:3  bounded-ts/declaration-only  no bodies"]);
  });

  test("a file outside cwd stays locatable as a relative path", () => {
    expect(formatProblems([result("/other/x.ts", [message({ line: 2, column: 5 })])], "/proj")).toEqual([
      "../other/x.ts:2:5  bounded-ts/declaration-only  a contract may only declare",
    ]);
  });

  test("formats one line per error and none for warnings", () => {
    const lines = formatProblems(
      [
        result("/proj/src/a.ts", [
          message({ severity: 1 }),
          message({ severity: 2, line: 7, column: 1 }),
          message({ severity: 2, line: 9, column: 2 }),
        ]),
      ],
      "/proj",
    );
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.split("  ")[0])).toEqual(["src/a.ts:7:1", "src/a.ts:9:2"]);
  });
});
