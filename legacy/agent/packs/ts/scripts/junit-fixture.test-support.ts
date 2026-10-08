// Test support: a canned `bun test` run — the JUnit report and the console
// report bun writes beside it — for gate tests that replace the suite command
// (BOUNDED_GATE_TEST_CMD). The shapes follow bun 1.3.14's real output
// (testdata/bun-junit/): one <testsuite> per file with nested describes, and
// on stderr a code frame, a caret line, the error, stack frames and a
// `(fail) <name> [<ms>]` marker per failure.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CannedCase {
  /** `Describe > test`, as bun names it. */
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped" | "todo";
  /** The error text a failure prints, e.g. `NotImplementedError: Not implemented: Note.equals`. */
  readonly message?: string;
  /** The project-relative test file; default `contexts/notebook/src/x.test.ts`. */
  readonly file?: string;
}

const escape = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The JUnit XML and stderr bun would write for these cases. */
export function cannedRun(cases: readonly CannedCase[]): { xml: string; stderr: string } {
  const byFile = new Map<string, CannedCase[]>();
  for (const c of cases) {
    const file = c.file ?? "contexts/notebook/src/x.test.ts";
    byFile.set(file, [...(byFile.get(file) ?? []), c]);
  }
  const suites: string[] = [];
  const stderr: string[] = [];
  for (const [file, list] of byFile) {
    stderr.push(`${file}:`);
    const body = list.map((c) => {
      const parts = c.name.split(" > ");
      const test = parts.pop()!;
      const inner = c.status === "failed"
        ? '<failure type="Error" />'
        : c.status === "skipped" ? "<skipped />" : c.status === "todo" ? '<skipped message="TODO" />' : "";
      if (c.status === "failed") {
        stderr.push("1 | const probe = 1;", "    ^", c.message ?? "error: failed", "      at <anonymous> (/tmp/project/x.ts:1:1)", `(fail) ${c.name} [0.10ms]`);
      }
      const testcase = inner === ""
        ? `<testcase name="${escape(test)}" file="${escape(file)}" time="0.0001" />`
        : `<testcase name="${escape(test)}" file="${escape(file)}" time="0.0001">${inner}</testcase>`;
      return parts.reduceRight((xml, describe) => `<testsuite name="${escape(describe)}" file="${escape(file)}">${xml}</testsuite>`, testcase);
    });
    suites.push(`<testsuite name="${escape(file)}" file="${escape(file)}">${body.join("")}</testsuite>`);
  }
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${cases.length}">${suites.join("")}</testsuites>\n`,
    stderr: `${stderr.join("\n")}\n`,
  };
}

/**
 * Write a canned run into `dir` and return the environment that makes the
 * gates replay it instead of running bun, and replay `tsc` (text and exit
 * code) instead of the type checker.
 */
export function cannedGateEnv(
  dir: string,
  cases: readonly CannedCase[],
  tsc: { readonly output?: string; readonly code?: number } = {},
): Record<string, string> {
  const run = cannedRun(cases);
  writeFileSync(join(dir, ".canned-report.xml"), run.xml);
  writeFileSync(join(dir, ".canned-stderr.txt"), run.stderr);
  writeFileSync(join(dir, ".canned-tsc.txt"), tsc.output ?? "");
  return {
    BOUNDED_GATE_TEST_CMD: "sh",
    BOUNDED_GATE_TEST_ARGS: JSON.stringify(["-c", `cat '${join(dir, ".canned-report.xml")}'; cat '${join(dir, ".canned-stderr.txt")}' >&2; exit ${cases.some((c) => c.status === "failed") ? 1 : 0}`]),
    BOUNDED_GATE_TSC_CMD: "sh",
    BOUNDED_GATE_TSC_ARGS: JSON.stringify(["-c", `cat '${join(dir, ".canned-tsc.txt")}'; exit ${tsc.code ?? 0}`]),
  };
}

/** Run `body` with `env` applied to this process, restoring it after. */
export async function withEnv<T>(env: Readonly<Record<string, string | undefined>>, body: () => Promise<T> | T): Promise<T> {
  const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
