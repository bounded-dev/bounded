// The layer and dependency rules (AGENTS.md "Layout"), adapted from the Bounded
// harness's hexagonal worked example. Every import of every file under
// contexts/*/src is read with the TypeScript parser.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = import.meta.dir;
const LAYERS = ["domain", "application", "adapters", "pack"] as const;
type Layer = (typeof LAYERS)[number];
/** What each layer may import from its own context: dependencies point inwards. */
const ALLOWED: Record<Layer, readonly Layer[]> = {
  domain: ["domain"],
  application: ["domain", "application"],
  adapters: ["domain", "application", "adapters"],
  pack: ["domain", "application", "adapters", "pack"],
};
const IO_MODULES = /^(bun|bun:.*|node:.*|fs|path|child_process|net|os)$/;

interface Context {
  readonly dir: string;
  readonly name: string;
  readonly exports: Record<string, string>;
  readonly dependencies: readonly string[];
}

const contexts: Context[] = [];
for (const manifest of new Glob("contexts/*/package.json").scanSync({ cwd: ROOT })) {
  const pkg = (await Bun.file(`${ROOT}/${manifest}`).json()) as { name: string; exports?: Record<string, string>; dependencies?: Record<string, string> };
  contexts.push({ dir: manifest.replace("/package.json", ""), name: pkg.name, exports: pkg.exports ?? {}, dependencies: Object.keys(pkg.dependencies ?? {}) });
}
const byName = new Map(contexts.map((c) => [c.name, c]));

/** The layer an export path or a source path belongs to. */
function layerOf(inner: string): Layer | undefined {
  const head = inner.split("/")[0];
  return LAYERS.find((layer) => layer === head);
}

function importsOf(path: string, text: string): { spec: string; line: number; typeOnly: boolean }[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: { spec: string; line: number; typeOnly: boolean }[] = [];
  const visit = (node: ts.Node): void => {
    let spec: ts.Expression | undefined;
    let typeOnly = false;
    if (ts.isImportDeclaration(node)) [spec, typeOnly] = [node.moduleSpecifier, node.importClause?.isTypeOnly === true];
    else if (ts.isExportDeclaration(node)) [spec, typeOnly] = [node.moduleSpecifier, node.isTypeOnly];
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) spec = node.arguments[0];
    if (spec !== undefined) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      out.push({ spec: ts.isStringLiteral(spec) ? spec.text : "<computed>", line, typeOnly });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

const violations: string[] = [];
const files = [...new Glob("contexts/*/src/**/*.ts").scanSync({ cwd: ROOT, dot: true })].sort();
for (const path of files) {
  const [, contextName = "", , ...rest] = path.split("/");
  const context = contexts.find((c) => c.dir === `contexts/${contextName}`);
  const layer = layerOf(rest.join("/"));
  const isTest = /\.test(-support)?\.ts$/.test(path);
  if (context === undefined || layer === undefined) {
    violations.push(`${path} — every file sits in src/domain, src/application, src/adapters or src/pack of a context with a package.json`);
    continue;
  }
  const text = await Bun.file(`${ROOT}/${path}`).text();
  const pure = (layer === "domain" || layer === "application") && !isTest;
  if (pure && /\b(Bun|process|fetch|require)\s*[.(]/.test(text)) violations.push(`${path} — ${layer} code does no I/O`);
  for (const { spec, line, typeOnly } of importsOf(path, text)) {
    const at = `${path}:${line} imports "${spec}"`;
    if (spec.startsWith(".")) {
      const target = new URL(spec, `file:///${path}`).pathname.slice(1);
      const [, targetContext = "", , ...targetRest] = target.split("/");
      const targetLayer = layerOf(targetRest.join("/"));
      if (targetContext !== contextName) violations.push(`${at} — reach another context through its package, never a relative path`);
      else if (targetLayer === undefined || !ALLOWED[layer].includes(targetLayer)) violations.push(`${at} — ${layer} may not depend on ${targetLayer ?? "files outside the layers"}`);
      else if (layer !== "domain" && targetLayer !== layer && !isTest) violations.push(`${at} — import another layer through the package's export path`);
      continue;
    }
    const target = contexts.find((c) => spec === c.name || spec.startsWith(`${c.name}/`));
    if (target !== undefined) {
      const exportPath = spec.slice(target.name.length + 1);
      const targetLayer = layerOf(exportPath);
      if (!(`./${exportPath}` in target.exports) || targetLayer === undefined) violations.push(`${at} — import a context only through its export paths`);
      else if (target !== context && !context.dependencies.includes(target.name)) violations.push(`${at} — ${context.name} does not declare ${target.name} as a dependency`);
      else if (target === context && !ALLOWED[layer].includes(targetLayer)) violations.push(`${at} — ${layer} may not depend on ${targetLayer}`);
      else if (target === context && layer === "domain") violations.push(`${at} — domain files import each other by relative path`);
      continue;
    }
    if (spec === "<computed>") violations.push(`${at} — an import with a computed specifier cannot be checked`);
    else if (pure && !typeOnly && spec !== "zod") violations.push(`${at} — ${layer} code uses no library but zod${IO_MODULES.test(spec) ? " and does no I/O" : ""}`);
  }
}

describe("architecture", () => {
  test("the core is a workspace package exporting each of its layers", () => {
    const core = byName.get("bounded");
    expect(core?.dir).toBe("contexts/core");
    expect(Object.keys(core?.exports ?? {}).sort()).toEqual(["./adapters/in-memory", "./application", "./domain"]);
  });

  test("every export path points at a file that exists", async () => {
    for (const context of contexts) {
      for (const target of Object.values(context.exports)) expect(await Bun.file(`${ROOT}/${context.dir}/${target}`).exists()).toBe(true);
    }
  });

  test("the scan reads source files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("layers, dependencies and I/O follow the rules", () => {
    expect(violations).toEqual([]);
  });
});
