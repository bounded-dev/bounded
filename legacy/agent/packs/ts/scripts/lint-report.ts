// Shared lint reporting for the gate scripts (contract-purity, lint-src).
//
// Extracted because the two gates were carrying byte-identical copies of it,
// and a copy is a place two gates can start disagreeing about what a problem
// looks like. This module deliberately imports NOTHING from the bounded-ts
// plugin: a BUILD-stage gate must not fail to load because a DESIGN-stage rule
// is mid-edit, which is the coupling the duplication was avoiding.

import { relative } from "node:path";
import type { ESLint } from "eslint";

export interface Problem {
  filePath: string;
  line: number;
  column: number;
  ruleId: string;
  message: string;
}

/** Errors only. A warning that does not fail a gate is advice, and the gates
 *  do not give advice. */
export function toProblems(results: ESLint.LintResult[]): Problem[] {
  return results.flatMap((r) =>
    r.messages
      .filter((m) => m.severity === 2)
      .map((m) => ({
        filePath: r.filePath,
        line: m.line,
        column: m.column,
        ruleId: m.ruleId ?? "<parse>",
        message: m.message,
      })),
  );
}

/** One greppable line per problem: `path:line:col  rule  message`. */
export function formatProblems(results: ESLint.LintResult[], cwd: string): string[] {
  return toProblems(results).map(
    (p) => `${relative(cwd, p.filePath)}:${p.line}:${p.column}  ${p.ruleId}  ${p.message}`,
  );
}
