// The layer and dependency rules (AGENTS.md "Layout"), adapted from the Bounded
// harness's hexagonal worked example. Every import of every file under
// contexts/*/src is read with the TypeScript parser.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = import.meta.dir;
const LAYERS = ["domain", "application", "adapters", "packs", "pack"] as const;
type Layer = (typeof LAYERS)[number];
/** What each layer may import from its own context: dependencies point inwards. */
const ALLOWED: Record<Layer, readonly Layer[]> = {
  domain: ["domain"],
  application: ["domain", "application"],
  adapters: ["domain", "application", "adapters"],
  packs: ["domain", "packs"],
  pack: ["domain", "application", "adapters", "packs", "pack"],
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

/** The layer a source path (relative to src/) belongs to. */
function layerOf(inner: string): Layer | undefined {
  const head = inner.split("/")[0];
  return LAYERS.find((layer) => layer === head);
}

/** The layer an export path belongs to: the layer of the file it points at. */
function exportLayerOf(context: Context, exportPath: string): Layer | undefined {
  const target = context.exports[`./${exportPath}`];
  return target === undefined ? undefined : layerOf(target.replace(/^\.\/src\//, ""));
}

/**
 * A pack shipped in a context's package lives in its own directory,
 * src/packs/<name>/, and is an ordinary pack: its code depends only on the
 * package's public `domain` export path, its own directory and the libraries
 * the package declares, and does no I/O. Nothing outside that directory
 * imports it, except tests under the composition root (src/pack/), so the
 * core never depends on a pack (ADR 2026-009).
 */
function shippedPackViolations(path: string, imports: readonly { spec: string; line: number }[], context: Context): string[] {
  const packDir = (file: string | undefined) => (file === undefined ? undefined : /^contexts\/[^/]+\/src\/packs\/[^/]+\//.exec(file)?.[0]);
  const own = packDir(path);
  const isTest = /\.test(-support)?\.ts$/.test(path);
  const rootTest = isTest && /^contexts\/[^/]+\/src\/pack\//.test(path);
  const out: string[] = [];
  for (const { spec, line } of imports) {
    const at = `${path}:${line} imports "${spec}"`;
    const relative = spec.startsWith(".");
    const exported = relative ? undefined : contexts.find((c) => spec.startsWith(`${c.name}/`));
    const exportTarget = exported?.exports[`./${spec.slice((exported?.name.length ?? 0) + 1)}`];
    const file = relative ? new URL(spec, `file:///${path}`).pathname.slice(1) : exportTarget === undefined ? undefined : `${exported?.dir}/${exportTarget.slice(2)}`;
    const into = packDir(file);
    if (into !== undefined && into !== own && !rootTest) out.push(`${at} — only a pack's own directory imports it: the core and other packs never depend on a shipped pack`);
    if (own === undefined || isTest) continue;
    if (relative) {
      if (into !== own) out.push(`${at} — a shipped pack reaches the core through \`${context.name}/domain\` only`);
    } else if (exported !== undefined) {
      if (spec !== `${context.name}/domain`) out.push(`${at} — a shipped pack depends only on \`${context.name}/domain\`, the core's public exports`);
    } else if (IO_MODULES.test(spec) || !context.dependencies.includes(spec)) {
      out.push(`${at} — a shipped pack uses only libraries its package declares, and does no I/O`);
    }
  }
  return out;
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

/**
 * Every packIdsFor(...) (or PackId.forPackage(...)) call in a workspace's
 * source names that workspace's npm package, so a pack's id always starts
 * with the package it ships in (ADR 2026-004). Tests and fixtures build
 * packs of imaginary packages and are exempt.
 */
const CORE = "bounded";

/**
 * It guards against mistakes, not deliberate bypass: an alias of the
 * factory, PackId.parse outside the core and casts are flagged where they
 * can be seen, but code determined to forge an id can still do so.
 */
function packIdViolations(path: string, text: string, packageName: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const at = (node: ts.Node) => `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && node.propertyName?.text === "packIdsFor") {
      out.push(`${at(node)} — import packIdsFor under its own name, so this rule can see every call`);
    }
    if (ts.isCallExpression(node) && packageName !== CORE && ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "PackId" && node.expression.name.text === "parse") {
      out.push(`${at(node)} — PackId.parse is the core's; build this workspace's ids with packIdsFor("${packageName}")`);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const named = (ts.isIdentifier(callee) && callee.text === "packIdsFor") || (ts.isPropertyAccessExpression(callee) && callee.name.text === "forPackage");
      const argument = node.arguments[0];
      if (named && !(argument !== undefined && ts.isStringLiteral(argument) && argument.text === packageName)) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        out.push(`${path}:${line} — pack ids in this workspace come from packIdsFor("${packageName}"), the name in its package.json`);
      }
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
  const shippedPack = layer === "packs";
  if (shippedPack && rest.length < 3) violations.push(`${path} — a shipped pack lives in its own directory, src/packs/<name>/`);
  const pure = (layer === "domain" || layer === "application" || shippedPack) && !isTest;
  if (!isTest) violations.push(...packIdViolations(path, text, context.name));
  violations.push(...shippedPackViolations(path, importsOf(path, text), context));
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
      const targetLayer = exportLayerOf(target, exportPath);
      if (!(`./${exportPath}` in target.exports) || targetLayer === undefined) violations.push(`${at} — import a context only through its export paths`);
      else if (target !== context && !context.dependencies.includes(target.name)) violations.push(`${at} — ${context.name} does not declare ${target.name} as a dependency`);
      else if (target === context && !ALLOWED[layer].includes(targetLayer)) violations.push(`${at} — ${layer} may not depend on ${targetLayer}`);
      else if (target === context && layer === "domain") violations.push(`${at} — domain files import each other by relative path`);
      continue;
    }
    if (spec === "<computed>") violations.push(`${at} — an import with a computed specifier cannot be checked`);
    else if (pure && !shippedPack && !typeOnly && spec !== "zod") violations.push(`${at} — ${layer} code uses no library but zod${IO_MODULES.test(spec) ? " and does no I/O" : ""}`);
  }
}

describe("architecture", () => {
  test("the core is a workspace package exporting each of its layers", () => {
    const core = byName.get("bounded");
    expect(core?.dir).toBe("contexts/core");
    expect(Object.keys(core?.exports ?? {}).sort()).toEqual(["./adapters/in-memory", "./application", "./domain", "./path-gate"]);
  });

  test("the path gate is a pack shipped in the bounded package, in its own directory", () => {
    expect(byName.get("bounded")?.exports["./path-gate"]).toBe("./src/packs/path-gate/index.ts");
  });

  test("the shipped-pack rule: only a pack's own directory imports it, and it depends only on the core's public exports", () => {
    const core = byName.get("bounded");
    if (core === undefined) throw new Error("no core context");
    const gate = "contexts/core/src/packs/path-gate/gate.ts";
    const imports = (...specs: string[]) => specs.map((spec) => ({ spec, line: 1 }));
    expect(shippedPackViolations(gate, imports("bounded/domain", "./rule.ts", "picomatch"), core)).toEqual([]);
    expect(shippedPackViolations(gate, imports("bounded/application", "../../domain/index.ts", "node:fs"), core)).toEqual([
      `${gate}:1 imports "bounded/application" — a shipped pack depends only on \`bounded/domain\`, the core's public exports`,
      `${gate}:1 imports "../../domain/index.ts" — a shipped pack reaches the core through \`bounded/domain\` only`,
      `${gate}:1 imports "node:fs" — a shipped pack uses only libraries its package declares, and does no I/O`,
    ]);
    expect(shippedPackViolations("contexts/core/src/domain/guards/x.ts", imports("bounded/path-gate", "../../packs/path-gate/index.ts"), core)).toEqual([
      'contexts/core/src/domain/guards/x.ts:1 imports "bounded/path-gate" — only a pack\'s own directory imports it: the core and other packs never depend on a shipped pack',
      'contexts/core/src/domain/guards/x.ts:1 imports "../../packs/path-gate/index.ts" — only a pack\'s own directory imports it: the core and other packs never depend on a shipped pack',
    ]);
    expect(shippedPackViolations("contexts/core/src/pack/end-to-end.test.ts", imports("bounded/path-gate"), core)).toEqual([]);
    expect(shippedPackViolations("contexts/core/src/pack/root.ts", imports("bounded/path-gate"), core)).toHaveLength(1);
    expect(shippedPackViolations("contexts/core/src/packs/other/x.test.ts", imports("bounded/path-gate"), core)).toHaveLength(1);
  });

  test("every export path points at a file that exists", async () => {
    for (const context of contexts) {
      for (const target of Object.values(context.exports)) expect(await Bun.file(`${ROOT}/${context.dir}/${target}`).exists()).toBe(true);
    }
  });

  test("the scan reads source files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("the pack-id rule flags a call that does not name the workspace's package", () => {
    expect(packIdViolations("a.ts", 'packIdsFor("bounded")("core");', "bounded")).toEqual([]);
    expect(packIdViolations("a.ts", 'packIdsFor("other")("core");', "bounded")).toEqual([
      'a.ts:1 — pack ids in this workspace come from packIdsFor("bounded"), the name in its package.json',
    ]);
    expect(packIdViolations("a.ts", "const p = PackId.forPackage(name);", "bounded")).toHaveLength(1);
    expect(packIdViolations("a.ts", 'import { packIdsFor as ids } from "bounded/domain";', "my-pack")).toEqual([
      "a.ts:1 — import packIdsFor under its own name, so this rule can see every call",
    ]);
    expect(packIdViolations("a.ts", 'const id = PackId.parse("bounded/core");', "my-pack")).toEqual([
      'a.ts:1 — PackId.parse is the core\'s; build this workspace\'s ids with packIdsFor("my-pack")',
    ]);
    expect(packIdViolations("a.ts", 'const id = PackId.parse("bounded/core");', "bounded")).toEqual([]);
  });

  test("layers, dependencies and I/O follow the rules", () => {
    expect(violations).toEqual([]);
  });
});
