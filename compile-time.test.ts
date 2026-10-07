// The compile-time half of the ownership rule: a contribution across an
// undeclared dependency must not compile. Each context's
// test/fixtures/compile-time/ holds an accepted.ts that must compile cleanly
// and a rejected.ts in which exactly the lines marked `// rejected` fail.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = import.meta.dir;
const config = ts.readConfigFile(`${ROOT}/tsconfig.base.json`, ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options;

/** The 1-based lines of `file` the compiler reports an error on. */
function errorLines(file: string): number[] {
  const program = ts.createProgram([file], options);
  const source = program.getSourceFile(file);
  const lines = ts
    .getPreEmitDiagnostics(program, source)
    .filter((d) => d.file?.fileName === file && d.start !== undefined)
    .map((d) => (d.file as ts.SourceFile).getLineAndCharacterOfPosition(d.start as number).line + 1);
  return [...new Set(lines)].sort((a, b) => a - b);
}

const fixtures = [...new Glob("contexts/*/test/fixtures/compile-time/*.ts").scanSync({ cwd: ROOT })].sort();

describe("compile-time ownership check", () => {
  test("there are fixtures to compile", () => {
    expect(fixtures).toContain("contexts/core/test/fixtures/compile-time/accepted.ts");
    expect(fixtures).toContain("contexts/core/test/fixtures/compile-time/rejected.ts");
  });

  for (const fixture of fixtures) {
    test(`${fixture}: exactly the lines marked rejected fail to compile`, async () => {
      const file = `${ROOT}/${fixture}`;
      const marked = (await Bun.file(file).text())
        .split("\n")
        .flatMap((line, i) => (/\/\/ rejected\s*$/.test(line) ? [i + 1] : []));
      expect(errorLines(file)).toEqual(marked);
    }, 30_000);
  }
});
