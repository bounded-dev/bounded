import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";

// ADR 2026-056: the core names no project layout. Where source lives is the
// composed packs' `sourceRoots`, which files are test-side their
// `testFileSuffixes`, which are generated their `generatedFileGlobs`. A core
// literal `src/` or `tests/` used as policy is the layout creeping back in —
// the same failure as a core file naming a technology.
//
// This scans every string, template and regular-expression literal in the
// core (agent/src, non-test) and in the host adapters of the path gate, and
// refuses one that uses `src` or `tests` as a path segment. Comments are not
// literals, so prose that cites the harness's own files (`src/path-gate.ts`)
// is untouched, and so are module specifiers (`../../src/x.ts`), which name
// the harness's own modules rather than a project's layout.

const AGENT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Test-side names never carry policy. */
const TEST_SIDE = /\.test(?:-support)?\.tsx?$/;

function coreFiles(): string[] {
  const src = readdirSync(join(AGENT, "src"))
    .filter((name) => name.endsWith(".ts") && !TEST_SIDE.test(name))
    .map((name) => join(AGENT, "src", name));
  const loaders = readdirSync(join(AGENT, "hosts/pi/extensions/path-gate"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(AGENT, "hosts/pi/extensions/path-gate", name));
  return [
    ...src,
    join(AGENT, "hosts/claude-code/tool-map.ts"),
    join(AGENT, "hosts/claude-code/bash-policy.ts"),
    join(AGENT, "hosts/claude-code/path-gate-hook.ts"),
    join(AGENT, "hosts/pi/extensions/path-gate.ts"),
    ...loaders,
  ].sort();
}

/** `src` or `tests` as a whole path segment followed by a separator (plain or
 *  regex-escaped), at the start of the literal or after a non-name character
 *  — except right after `./` or `../`, which is a relative reference to one
 *  of the harness's own modules (`"$DIR/../src/lead-cli.ts"`), not a layout. */
const LAYOUT_SEGMENT = {
  test(literal: string): boolean {
    for (const match of literal.matchAll(/(?:src|tests)(?:\/|\\\/)/gi)) {
      const before = literal.slice(0, match.index);
      if (before === "" || /[^A-Za-z0-9_./\\-]$/.test(before)) return true;
      if (/(?:^|[^.])\\?\/$/.test(before) && !/(?:^|\/)\.{1,2}\\?\/$/.test(before)) return true;
    }
    return false;
  },
};

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isImportTypeNode(parent.parent ?? parent)) return true;
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    return parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(parent.expression) && parent.expression.text === "require");
  }
  return false;
}

function layoutLiterals(file: string): Hit[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: Hit[] = [];
  const visit = (node: ts.Node): void => {
    let literal: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literal = node.text;
    else if (ts.isRegularExpressionLiteral(node)) literal = node.text;
    if (literal !== undefined && !isModuleSpecifier(node) && LAYOUT_SEGMENT.test(literal)) {
      hits.push({
        file: relative(AGENT, file),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        text: literal,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/**
 * Literals that mention `src/` without being a project layout, each with its
 * reason. Keyed by file and exact literal text, so a new literal is never
 * covered by an old excuse.
 */
const NOT_LAYOUT: ReadonlyArray<{ readonly file: string; readonly text: string; readonly why: string }> = [
  {
    file: "src/project-init.ts",
    text: "node src/gates-cli.ts --list",
    why: "the copied harness's own entry point inside .bounded/harness, not a project path",
  },
  {
    file: "src/project-init.ts",
    text: "  - src/example/example",
    why: "the initializer's example TN entry; WI-9 moves it under a composed source root",
  },
];

describe("no core file uses a project layout literal (ADR 2026-056)", () => {
  test("the scan covers the path policy, the gate, ticket design, the socket readers and the host adapters", () => {
    const files = coreFiles().map((file) => relative(AGENT, file));
    for (const owned of [
      "src/path-policy.ts", "src/path-gate.ts", "src/ticket-design.ts", "src/pack-contrib.ts",
      "hosts/claude-code/tool-map.ts", "hosts/claude-code/bash-policy.ts", "hosts/pi/extensions/path-gate.ts",
    ]) {
      expect(files).toContain(owned);
    }
  });

  test("the detector sees every literal form and ignores prose and module specifiers", () => {
    const probe = (code: string) => {
      const source = ts.createSourceFile("probe.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      let found = false;
      const visit = (node: ts.Node): void => {
        let literal: string | undefined;
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node)) literal = node.text;
        if (literal !== undefined && !isModuleSpecifier(node) && LAYOUT_SEGMENT.test(literal)) found = true;
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    };
    expect(probe(`const a = "src/**";`)).toBe(true);
    expect(probe(`const a = 'tests/generated';`)).toBe(true);
    expect(probe("const a = `${x}/src/${y}`;")).toBe(true);
    expect(probe("const a = `src/**/*${s}`;")).toBe(true);
    expect(probe(`const r = /^src\\/(?:x)/;`)).toBe(true);
    expect(probe(`const a = "SRC/x";`)).toBe(true);
    expect(probe(`// src/path-policy.ts decides\nconst a = 1;`)).toBe(false);
    expect(probe(`import { x } from "../../src/x.ts";`)).toBe(false);
    expect(probe(`const m = await import("../src/y.ts");`)).toBe(false);
    expect(probe(`const a = "resources/x";`)).toBe(false);
    expect(probe(`const a = "my-src/x";`)).toBe(false);
    expect(probe(`const a = "a/src/x";`)).toBe(true);
    expect(probe(`const a = "exec node \\"$DIR/../src/cli.ts\\"";`)).toBe(false);
    expect(probe(`const a = "./tests/x";`)).toBe(false);
  });

  test("no literal src/ or tests/ outside the listed, reasoned exceptions", () => {
    const hits = coreFiles().flatMap(layoutLiterals);
    const unexplained = hits.filter((hit) => !NOT_LAYOUT.some((ok) => ok.file === hit.file && ok.text === hit.text));
    expect(unexplained, unexplained.map((h) => `${h.file}:${h.line} ${JSON.stringify(h.text)}`).join("\n")).toEqual([]);
  });

  test("every listed exception still exists, so the list cannot rot into a blanket pass", () => {
    const hits = coreFiles().flatMap(layoutLiterals);
    for (const ok of NOT_LAYOUT) {
      expect(hits.some((hit) => hit.file === ok.file && hit.text === ok.text), `${ok.file}: ${ok.text}`).toBe(true);
    }
  });
});
