// The compile-time half of the ownership rule: a contribution across an
// undeclared dependency must not compile. Every file in a context's
// test/fixtures/compile-time/ is compiled. A line of code ending in
// `// rejected: <reason>` must be covered by an error whose message contains
// <reason>; every error must cover such a line. Unmarked files compile cleanly.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = import.meta.dir;
const config = ts.readConfigFile(`${ROOT}/tsconfig.base.json`, ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options;

interface Diagnostic {
  readonly first: number;
  readonly last: number;
  readonly message: string;
}

/** The errors in `file`, each with the 1-based lines its span covers. */
function diagnostics(file: string): Diagnostic[] {
  const program = ts.createProgram([file], options);
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).flatMap((d) => {
    if (d.file?.fileName !== file || d.start === undefined) return [];
    const line = (at: number) => d.file?.getLineAndCharacterOfPosition(at).line ?? 0;
    return [{ first: line(d.start) + 1, last: line(d.start + (d.length ?? 0)) + 1, message: ts.flattenDiagnosticMessageText(d.messageText, " ") }];
  });
}

/** What does not hold: a marked line no matching error covers, or an error covering no marked line. */
function mismatches(file: string, text: string): string[] {
  const marked = text.split("\n").flatMap((line, i) => {
    const reason = /^(?!\s*\/\/).*\/\/ rejected: (.+?)\s*$/.exec(line)?.[1];
    return reason === undefined ? [] : [{ line: i + 1, reason }];
  });
  const found = diagnostics(file);
  const covers = (d: Diagnostic, line: number) => d.first <= line && line <= d.last;
  return [
    ...marked
      .filter((m) => !found.some((d) => covers(d, m.line) && d.message.includes(m.reason)))
      .map((m) => `line ${m.line} compiles, or fails for another reason than "${m.reason}": ${found.filter((d) => covers(d, m.line)).map((d) => d.message).join(" | ") || "no error"}`),
    ...found.filter((d) => !marked.some((m) => covers(d, m.line))).map((d) => `line ${d.first} fails unexpectedly: ${d.message}`),
  ];
}

const fixtures = [...new Glob("contexts/*/test/fixtures/compile-time/*.ts").scanSync({ cwd: ROOT })].sort();

describe("compile-time ownership check", () => {
  test("there are fixtures to compile", () => {
    expect(fixtures).toContain("contexts/core/test/fixtures/compile-time/accepted.ts");
    expect(fixtures).toContain("contexts/core/test/fixtures/compile-time/rejected.ts");
  });

  for (const fixture of fixtures) {
    test(`${fixture}: exactly the lines marked rejected fail, each for its stated reason`, async () => {
      const file = `${ROOT}/${fixture}`;
      expect(mismatches(file, await Bun.file(file).text())).toEqual([]);
    }, 30_000);
  }
});
