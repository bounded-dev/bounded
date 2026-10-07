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

interface Marker {
  readonly line: number;
  readonly reason: string;
}

/** Lines of code ending in `// rejected: <reason>`. */
function markers(text: string): Marker[] {
  return text.split("\n").flatMap((line, i) => {
    const reason = /^(?!\s*\/\/).*\/\/ rejected: (.+?)\s*$/.exec(line)?.[1];
    return reason === undefined ? [] : [{ line: i + 1, reason }];
  });
}

const covers = (d: Diagnostic, line: number): boolean => d.first <= line && line <= d.last;

const fixtures = [...new Glob("contexts/*/test/fixtures/compile-time/*.ts").scanSync({ cwd: ROOT })].sort();

describe("compile-time ownership check", () => {
  test("there are fixtures to compile", () => {
    expect(fixtures).toContain("contexts/core/test/fixtures/compile-time/accepted.ts");
    expect(fixtures).toContain("contexts/core/test/fixtures/compile-time/rejected.ts");
  });

  for (const fixture of fixtures) {
    const file = `${ROOT}/${fixture}`;

    test(`${fixture}: exactly the lines marked rejected fail to compile`, async () => {
      const marked = markers(await Bun.file(file).text());
      const found = diagnostics(file);
      expect(marked.filter((m) => !found.some((d) => covers(d, m.line))).map((m) => `line ${m.line} compiles`)).toEqual([]);
      expect(found.filter((d) => !marked.some((m) => covers(d, m.line))).map((d) => `line ${d.first}: ${d.message}`)).toEqual([]);
    }, 30_000);

    test(`${fixture}: exactly the lines marked rejected fail, each for its stated reason`, async () => {
      const found = diagnostics(file);
      const wrong = markers(await Bun.file(file).text()).filter((m) => !found.some((d) => covers(d, m.line) && d.message.includes(m.reason)));
      expect(wrong.map((m) => `line ${m.line} does not fail with "${m.reason}"`)).toEqual([]);
    }, 30_000);
  }
});
