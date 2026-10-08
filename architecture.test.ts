// The layer and dependency rules (AGENTS.md "Layout"), adapted from the Bounded
// harness's hexagonal worked example. Every import of every file under
// contexts/*/src and apps/*/src is read with the TypeScript parser.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import * as ts from "typescript";
import {
  adapterContractViolations,
  assertionViolations,
  barrelContracts,
  brandExportViolations,
  conceptTripletViolations,
  featureContractViolations,
  implementedByViolations,
  packLayoutViolations,
  packOverviewViolations,
  shapeCheckViolations,
  type SourceFile,
} from "./architecture.rules.test-support.ts";

const ROOT = import.meta.dir;
const LAYERS = ["domain", "application", "adapters", "packs", "composition-root"] as const;
type Layer = (typeof LAYERS)[number];
/** What each layer may import from its own context: dependencies point inwards. */
const ALLOWED: Record<Layer, readonly Layer[]> = {
  domain: ["domain"],
  application: ["domain", "application"],
  adapters: ["domain", "application", "adapters"],
  packs: ["domain", "packs"],
  // The composition root lists packs because its tests may import a shipped
  // pack; shippedPackViolations refuses the import in its non-test code.
  "composition-root": ["domain", "application", "adapters", "packs", "composition-root"],
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

// Apps (apps/<name>) are the programs built on the contexts, such as host
// adapters. An app may do I/O and use libraries, but reaches a context only
// through its export paths and declared dependencies, and never another app.
const apps: Context[] = [];
for (const manifest of new Glob("apps/*/package.json").scanSync({ cwd: ROOT })) {
  const pkg = (await Bun.file(`${ROOT}/${manifest}`).json()) as { name: string; exports?: Record<string, string>; dependencies?: Record<string, string> };
  apps.push({ dir: manifest.replace("/package.json", ""), name: pkg.name, exports: pkg.exports ?? {}, dependencies: Object.keys(pkg.dependencies ?? {}) });
}

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
 * the package declares. Nothing outside that directory imports it, except
 * tests under the composition root (src/composition-root/), so the core
 * never depends on a pack (ADR 2026-009). Inside, it is a small hexagon
 * (ADR 2026-013): `domain/` imports only itself; `application/` its own
 * domain and application; the files at its root its domain, application and
 * root, never its adapters; `adapters/out/<tech>/` its domain, application
 * and own technology, and alone may do I/O (`node:*`, never Bun).
 */
const packLayerOf = (file: string): string | undefined => {
  const rest = /^contexts\/[^/]+\/src\/packs\/[^/]+\/(.*)$/.exec(file)?.[1];
  if (rest === undefined) return undefined;
  const [first = "", second, third] = rest.split("/");
  if (first === "adapters" && second === "out" && third !== undefined) return `adapters/out/${third}`;
  return ["domain", "application"].includes(first) && rest.includes("/") ? first : "root";
};
/** What each layer of a shipped pack may import of its own pack. */
const PACK_LAYERS: Readonly<Record<string, readonly string[]>> = { domain: ["domain"], application: ["domain", "application"], root: ["domain", "application", "root"] };
function shippedPackViolations(path: string, imports: readonly { spec: string; line: number }[], context: Context): string[] {
  const packDir = (file: string | undefined) => (file === undefined ? undefined : /^contexts\/[^/]+\/src\/packs\/[^/]+\//.exec(file)?.[0]);
  const own = packDir(path);
  const isTest = /\.test(-support)?\.ts$/.test(path);
  const rootTest = isTest && /^contexts\/[^/]+\/src\/composition-root\//.test(path);
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
    const from = packLayerOf(path) ?? "root";
    const adapter = from.startsWith("adapters/");
    if (relative) {
      if (into !== own) out.push(`${at} — a shipped pack reaches the core through \`${context.name}/domain\` only`);
      else {
        const to = packLayerOf(file ?? "") ?? "root";
        const allowed = adapter ? ["domain", "application", from] : (PACK_LAYERS[from] ?? []);
        if (!allowed.includes(to)) out.push(`${at} — a pack's ${from} may not import its ${to}`);
      }
    } else if (exported !== undefined) {
      if (spec !== `${context.name}/domain`) out.push(`${at} — a shipped pack depends only on \`${context.name}/domain\`, the core's public exports`);
    } else if (adapter ? !spec.startsWith("node:") && !context.dependencies.includes(spec) : IO_MODULES.test(spec) || !context.dependencies.includes(spec)) {
      out.push(`${at} — ${adapter ? "a pack's adapter uses only node:* and libraries its package declares" : "a shipped pack uses only libraries its package declares, and does no I/O; only its adapters/out/ do"}`);
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

/**
 * Value objects are classes, as in the worked example (ADR 2026-012): never a
 * branded primitive. Refused anywhere in source: an intersection of a
 * primitive with anything else (`string & { readonly __role: true }`,
 * `string & Brand<"Role">`), and a type alias intersecting an object type
 * that declares a `__` property (`Text & { readonly __packId: Text }`).
 */
function brandedPrimitiveViolations(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const PRIMITIVES = new Set([ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword, ts.SyntaxKind.BigIntKeyword, ts.SyntaxKind.SymbolKeyword]);
  const declaresDunder = (node: ts.TypeNode): boolean =>
    ts.isTypeLiteralNode(node) && node.members.some((member) => member.name !== undefined && ts.isIdentifier(member.name) && member.name.text.startsWith("__"));
  const flag = (node: ts.Node): void => {
    out.push(`${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} — a value object is a class with a private constructor, as in the worked example, never a branded primitive or object: ${node.getText(file)}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIntersectionTypeNode(node) && node.types.some((member) => PRIMITIVES.has(member.kind)) && node.types.some((member) => !PRIMITIVES.has(member.kind))) flag(node);
    else if (ts.isTypeAliasDeclaration(node) && ts.isIntersectionTypeNode(node.type) && !node.type.types.some((member) => PRIMITIVES.has(member.kind)) && node.type.types.some(declaresDunder)) flag(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/**
 * A value-object class keeps its constructor private, and its file exports
 * that class as the factory (`export const X: Contract.XFactory = XImpl`), as
 * in the worked example. `classes` maps each contract a class implements to
 * the class.
 */
function valueObjectClassViolations(path: string, text: string, isValueObject: (contract: string) => boolean): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const at = (node: ts.Node) => `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const classes = new Map<string, string>();
  for (const node of file.statements.filter(ts.isClassDeclaration)) {
    const contracts = (node.heritageClauses ?? []).filter((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword).flatMap((clause) => clause.types.map((type) => type.expression.getText(file).replace(/^Contract\./, "")));
    const valueObjects = contracts.filter(isValueObject);
    if (node.name === undefined || valueObjects.length === 0) continue;
    for (const contract of valueObjects) classes.set(contract, node.name.text);
    const declared = node.members.find(ts.isConstructorDeclaration);
    const isPrivate = declared?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) === true;
    if (!isPrivate) out.push(`${at(node)} — ${node.name.text} is a value object: give it a private constructor, so only its parse and named constructors make one`);
  }
  for (const statement of file.statements.filter(ts.isVariableStatement)) {
    for (const declaration of statement.declarationList.declarations) {
      const factory = declaration.type?.getText(file).match(/^Contract\.(\w+)Factory$/)?.[1];
      const made = factory === undefined ? undefined : classes.get(factory);
      if (made !== undefined && declaration.initializer?.getText(file) !== made) out.push(`${at(declaration)} — export the class ${made} itself as the ${factory} factory, as in the worked example`);
    }
  }
  return out;
}

/**
 * Branded contracts that are not value objects, so no class implements them:
 * packs, points, declarations and contributions are identity objects made by
 * definePack, point and contribution (ADR 2026-003), and a configuration is
 * made by defineConfig (ADR 2026-010).
 */
const IDENTITY_OBJECTS = new Set(["BaseDeclaration", "PointDeclaration", "PointGroupDeclaration", "BasePack", "BasePortKey", "Pack", "BasePoint", "ExtensionPoint", "Contribution", "Config"]);

/** The branded interfaces a contract exports: each declares `__brand`, or extends one of the file's interfaces that does. */
function brandedContracts(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const interfaces = file.statements.filter(ts.isInterfaceDeclaration);
  const branded = new Set<string>();
  const declaresBrand = (node: ts.InterfaceDeclaration): boolean => node.members.some((member) => member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === "__brand");
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of interfaces) {
      const parents = (node.heritageClauses ?? []).flatMap((clause) => clause.types.map((type) => type.expression.getText(file)));
      if (!branded.has(node.name.text) && (declaresBrand(node) || parents.some((parent) => branded.has(parent)))) {
        branded.add(node.name.text);
        grew = true;
      }
    }
  }
  const exported = (node: ts.InterfaceDeclaration): boolean => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
  return interfaces.filter((node) => exported(node) && branded.has(node.name.text)).map((node) => node.name.text);
}

const violations: string[] = [];
const files = [...new Glob("contexts/*/src/**/*.ts").scanSync({ cwd: ROOT, dot: true })].sort();
for (const path of files) {
  const [, contextName = "", , ...rest] = path.split("/");
  const context = contexts.find((c) => c.dir === `contexts/${contextName}`);
  const layer = layerOf(rest.join("/"));
  const isTest = /\.test(-support)?\.ts$/.test(path);
  if (context === undefined || layer === undefined) {
    violations.push(`${path} — every file sits in src/domain, src/application, src/adapters or src/composition-root of a context with a package.json`);
    continue;
  }
  const text = await Bun.file(`${ROOT}/${path}`).text();
  const shippedPack = layer === "packs";
  if (shippedPack && rest.length < 3) violations.push(`${path} — a shipped pack lives in its own directory, src/packs/<name>/`);
  const pure = (layer === "domain" || layer === "application" || (shippedPack && !(packLayerOf(path) ?? "").startsWith("adapters/"))) && !isTest;
  if (!isTest) violations.push(...packIdViolations(path, text, context.name));
  if (!isTest) violations.push(...brandedPrimitiveViolations(path, text));
  violations.push(...shippedPackViolations(path, importsOf(path, text), context));
  if (pure && /\b(Bun|process|fetch|require)\s*[.(]/.test(text)) violations.push(`${path} — ${layer} code does no I/O`);
  if (!isTest && /\bBun\s*\./.test(text)) violations.push(`${path} — runtime code uses no Bun API: hosts such as pi run the core under node`);
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
    // Only an out adapter may load code chosen at run time (a project's
    // configuration file, ADR 2026-010); anywhere else it cannot be checked.
    if (spec === "<computed>") {
      if (!rest.join("/").startsWith("adapters/out/")) violations.push(`${at} — an import with a computed specifier cannot be checked; only an out adapter may load code at run time`);
    }
    else if (pure && !shippedPack && !typeOnly && spec !== "zod") violations.push(`${at} — ${layer} code uses no library but zod${IO_MODULES.test(spec) ? " and does no I/O" : ""}`);
  }
}

// Every branded contract but an identity object is implemented by a class in its context.
for (const context of contexts) {
  const sources = files.filter((path) => path.startsWith(`${context.dir}/`) && !/\.test(-support)?\.ts$/.test(path));
  const texts = await Promise.all(sources.map(async (path) => ({ path, text: await Bun.file(`${ROOT}/${path}`).text() })));
  for (const { path, text } of texts.filter(({ path }) => path.endsWith(".contract.ts"))) {
    for (const name of brandedContracts(path, text)) {
      const implemented = new RegExp(`^class \\w+(<[^>]*>)? implements (Contract\\.)?${name}\\b`, "m");
      if (!IDENTITY_OBJECTS.has(name) && !texts.some(({ text }) => implemented.test(text))) {
        violations.push(`${path} — ${name} is a value object: implement it with a class with a private constructor (class ${name}Impl implements Contract.${name}), as in the worked example`);
      }
    }
  }
  const valueObjects = new Set(texts.filter(({ path }) => path.endsWith(".contract.ts")).flatMap(({ path, text }) => brandedContracts(path, text)).filter((name) => !IDENTITY_OBJECTS.has(name)));
  for (const { path, text } of texts) violations.push(...valueObjectClassViolations(path, text, (contract) => valueObjects.has(contract)));
}

const appFiles = [...new Glob("apps/*/src/**/*.ts").scanSync({ cwd: ROOT, dot: true })].sort();
for (const path of appFiles) {
  const [, appName = ""] = path.split("/");
  const app = apps.find((a) => a.dir === `apps/${appName}`);
  if (app === undefined) {
    violations.push(`${path} — every app file sits in src/ of an app with a package.json`);
    continue;
  }
  const text = await Bun.file(`${ROOT}/${path}`).text();
  for (const { spec, line } of importsOf(path, text)) {
    const at = `${path}:${line} imports "${spec}"`;
    if (spec.startsWith(".")) {
      const target = new URL(spec, `file:///${path}`).pathname.slice(1);
      if (!target.startsWith(`${app.dir}/src/`)) violations.push(`${at} — an app reaches outside its own src only through packages`);
      continue;
    }
    const isPackage = (name: string): boolean => spec === name || spec.startsWith(`${name}/`);
    const otherApp = apps.find((a) => isPackage(a.name));
    if (otherApp !== undefined) {
      violations.push(`${at} — an app never imports an app`);
      continue;
    }
    const target = contexts.find((c) => isPackage(c.name));
    if (target !== undefined) {
      if (!(`./${spec.slice(target.name.length + 1)}` in target.exports)) violations.push(`${at} — import a context only through its export paths`);
      else if (!app.dependencies.includes(target.name)) violations.push(`${at} — ${app.name} does not declare ${target.name} as a dependency`);
      continue;
    }
    if (spec === "<computed>") violations.push(`${at} — an import with a computed specifier cannot be checked`);
  }
}

// The contract rules R1–R6 (architecture.rules.test-support.ts): every file of every context, tests included.
const contextSources: SourceFile[] = await Promise.all(files.map(async (path) => ({ path, text: await Bun.file(`${ROOT}/${path}`).text() })));
const barrels = new Map<string, ReadonlyMap<string, string>>();
for (const context of contexts) {
  const barrel = contextSources.find(({ path }) => path === `${context.dir}/src/application/index.ts`);
  if (barrel !== undefined) barrels.set(`${context.name}/application`, barrelContracts(barrel));
}
/** Ports excused from R2, each with its reason. */
const UNTESTED_PORTS = new Map<string, string>();
/** Files excused from R3, each with its reason. */
const NOT_CONCEPTS = new Map([
  ["contexts/core/src/domain/shared/result.ts", "the shared kernel: Result, no concept"],
  ["contexts/core/src/domain/shared/read.ts", "the shared kernel: reading untyped input safely"],
  ["contexts/core/src/domain/shared/text.ts", "the shared kernel: text helpers"],
  ["contexts/core/src/domain/shared/wire.ts", "the shared kernel: wire forms of value objects"],
]);
/** R5: the files that route events, each with the type assertions it may have. */
const ASSERTIONS = new Map([
  ["contexts/core/src/domain/guards/dispatch.ts", 0],
  ["contexts/core/src/domain/guards/dispatch-event.ts", 0],
  ["contexts/core/src/domain/events/effect.contract.ts", 0],
  // functionOf: a contributed function's signature cannot be checked at run time (ADR 2026-007).
  ["contexts/core/src/domain/core-pack/guard-points.ts", 1],
]);
/** R6: files with a shape check that owns no shape, each with its reason. */
const SHAPE_CHECKS = new Map([
  ["contexts/core/src/domain/guards/dispatch.ts", "a guard's return value is contributed code's output, a boundary: the promise check stays beside Verdict.parse because its message names the guard"],
]);
const texts = new Map(contextSources.map(({ path, text }) => [path, text]));
violations.push(
  ...adapterContractViolations(contextSources, barrels),
  ...implementedByViolations(contextSources, barrels, UNTESTED_PORTS),
  ...conceptTripletViolations(files, texts, NOT_CONCEPTS),
  ...packLayoutViolations(files),
  ...packOverviewViolations(contextSources),
  ...featureContractViolations(files, texts),
  ...assertionViolations(contextSources, ASSERTIONS),
  ...shapeCheckViolations(contextSources, SHAPE_CHECKS),
  ...brandExportViolations(contextSources),
);

describe("architecture", () => {
  test("the Claude Code adapter is an app depending on the core", () => {
    const app = apps.find((a) => a.name === "bounded-claude-code");
    expect(app?.dir).toBe("apps/claude-code");
    // The core, and picomatch to split a search filter's fixed part from its pattern.
    expect(app?.dependencies).toEqual(["bounded", "picomatch"]);
    expect(appFiles.some((path) => path.startsWith("apps/claude-code/src/"))).toBe(true);
  });


  test("the core is a workspace package exporting each of its layers", () => {
    const core = byName.get("bounded");
    expect(core?.dir).toBe("contexts/core");
    expect(Object.keys(core?.exports ?? {}).sort()).toEqual(["./adapters/file-system", "./adapters/in-memory", "./adapters/system", "./application", "./domain", "./open-project", "./path-gate", "./path-gate/adapters/file-system", "./path-gate/adapters/in-memory", "./path-gate/adapters/tree-sitter", "./testing/host-installer-conformance"]);
  });

  test("the pi host adapter is an app depending on the core", () => {
    const pi = apps.find((a) => a.name === "bounded-pi");
    expect(pi?.dir).toBe("apps/pi");
    expect(pi?.dependencies).toContain("bounded");
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
      `${gate}:1 imports "node:fs" — a shipped pack uses only libraries its package declares, and does no I/O; only its adapters/out/ do`,
    ]);
    expect(shippedPackViolations("contexts/core/src/domain/guards/x.ts", imports("bounded/path-gate", "../../packs/path-gate/index.ts"), core)).toEqual([
      'contexts/core/src/domain/guards/x.ts:1 imports "bounded/path-gate" — only a pack\'s own directory imports it: the core and other packs never depend on a shipped pack',
      'contexts/core/src/domain/guards/x.ts:1 imports "../../packs/path-gate/index.ts" — only a pack\'s own directory imports it: the core and other packs never depend on a shipped pack',
    ]);
    expect(shippedPackViolations("contexts/core/src/composition-root/end-to-end.test.ts", imports("bounded/path-gate"), core)).toEqual([]);
    expect(shippedPackViolations("contexts/core/src/composition-root/root.ts", imports("bounded/path-gate"), core)).toHaveLength(1);
    expect(shippedPackViolations("contexts/core/src/packs/other/x.test.ts", imports("bounded/path-gate"), core)).toHaveLength(1);
    // Inside a pack: a small hexagon.
    const at = (file: string) => `contexts/core/src/packs/path-gate/${file}`;
    expect(shippedPackViolations(at("adapters/out/file-system/files.ts"), imports("node:fs", "../../../domain/rule.ts", "../../../application/feature/feature.contract.ts", "./other.ts"), core)).toEqual([]);
    expect(shippedPackViolations(at("domain/rule.ts"), imports("node:fs"), core)).toEqual([`${at("domain/rule.ts")}:1 imports "node:fs" — a shipped pack uses only libraries its package declares, and does no I/O; only its adapters/out/ do`]);
    expect(shippedPackViolations(at("application/feature/feature.ts"), imports("../../adapters/out/file-system/files.ts"), core)).toEqual([`${at("application/feature/feature.ts")}:1 imports "../../adapters/out/file-system/files.ts" — a pack's application may not import its adapters/out/file-system`]);
    expect(shippedPackViolations(at("index.ts"), imports("./adapters/out/file-system/index.ts"), core)).toEqual([`${at("index.ts")}:1 imports "./adapters/out/file-system/index.ts" — a pack's root may not import its adapters/out/file-system`]);
    expect(shippedPackViolations(at("domain/rule.ts"), imports("../application/feature/feature.ts"), core)).toHaveLength(1);
    expect(shippedPackViolations(at("adapters/out/in-memory/files.ts"), imports("../file-system/files.ts"), core)).toHaveLength(1);
  });

  test("every export path points at a file that exists", async () => {
    for (const context of [...contexts, ...apps]) {
      for (const target of Object.values(context.exports)) expect(await Bun.file(`${ROOT}/${context.dir}/${target}`).exists()).toBe(true);
    }
  });

  test("every export path resolves through its package name and loads", async () => {
    for (const context of [...contexts, ...apps]) {
      for (const exportPath of Object.keys(context.exports)) {
        const spec = exportPath === "." ? context.name : `${context.name}/${exportPath.slice(2)}`;
        // Resolved as a package resolves its own name (exports self-reference), from its directory.
        const loaded: unknown = await import(Bun.resolveSync(spec, `${ROOT}/${context.dir}`));
        expect(typeof loaded).toBe("object");
      }
    }
  });

  test("the scan reads source files", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(appFiles.length).toBeGreaterThan(0);
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

  test("the value-object rule flags a branded primitive or object, and nothing else", () => {
    expect(brandedPrimitiveViolations("a.ts", "export type Role = string & { readonly __role: true };")).toHaveLength(1);
    expect(brandedPrimitiveViolations("a.ts", "export type PackId<T extends string> = T & { readonly __packId: T };")).toHaveLength(1);
    expect(brandedPrimitiveViolations("a.ts", "type Owned = BasePack & { readonly id: Owner };")).toEqual([]);
    expect(brandedPrimitiveViolations("a.ts", "export type Role = string & Brand<\"Role\">;")).toHaveLength(1);
    expect(brandedPrimitiveViolations("a.ts", "export interface Use { readonly path: string & { readonly __path: true } }")).toHaveLength(1);
    expect(brandedPrimitiveViolations("a.ts", "function f<P extends string>(pkg: P & Check<P>): void {}")).toEqual([]);
    expect(brandedPrimitiveViolations("a.ts", "export interface Role { readonly __brand: \"Role\"; readonly value: string }")).toEqual([]);
  });

  test("the value-object rule wants a private constructor and the class itself as the factory", () => {
    const isValueObject = (name: string) => name === "Role";
    const good = "class RoleImpl implements Contract.Role {\n  private constructor(readonly value: string) {}\n}\nexport const Role: Contract.RoleFactory = RoleImpl;";
    expect(valueObjectClassViolations("a.ts", good, isValueObject)).toEqual([]);
    const open = "class RoleImpl implements Contract.Role {\n  constructor(readonly value: string) {}\n}\nexport const Role: Contract.RoleFactory = Object.freeze({ parse });";
    expect(valueObjectClassViolations("a.ts", open, isValueObject)).toHaveLength(2);
  });

  test("the value-object rule finds every branded contract, including one that inherits its brand", () => {
    const contract = "interface Base { readonly __brand: \"Effect\" }\nexport interface Read extends Base { readonly path: string }\nexport interface Plain { readonly path: string }\nexport interface Id { readonly __brand: \"Id\" }";
    expect(brandedContracts("a.contract.ts", contract)).toEqual(["Read", "Id"]);
  });

  test("no runtime code in a context uses Bun's API: pi runs the core under node", () => {
    expect(violations.filter((violation) => violation.includes("uses no Bun API"))).toEqual([]);
  });

  test("R1: an out adapter implements a port an application contract declares, and its file exports nothing else", () => {
    const barrel = { path: "contexts/x/src/application/index.ts", text: 'export type { Clock } from "./guard-log/judge/judge.contract.ts";\n' };
    const barrels = new Map([["x/application", barrelContracts(barrel)]]);
    const good = { path: "contexts/x/src/adapters/out/system/clock.ts", text: 'import type { Clock } from "x/application";\nexport class SystemClock implements Clock { now() { return ""; } }\n' };
    const bare = { path: "contexts/x/src/adapters/out/system/other.ts", text: "export class Other { now() { return \"\"; } }\n" };
    const mixed = { path: "contexts/x/src/adapters/out/system/mixed.ts", text: 'import type { Clock } from "x/application";\nexport class Mixed implements Clock {}\nexport const helper = 1;\n' };
    expect(adapterContractViolations([good], barrels)).toEqual([]);
    expect(adapterContractViolations([bare], barrels)).toEqual(["contexts/x/src/adapters/out/system/other.ts — Other implements no port of an application contract: an out adapter implements a port its feature's contract declares"]);
    expect(adapterContractViolations([mixed], barrels)).toEqual(["contexts/x/src/adapters/out/system/mixed.ts — a file with an adapter class exports nothing else: move its helpers to a file of their own"]);
  });

  test("R2: a port tagged @implementedBy has that adapter, a conformance suite, and a test running it beside the adapter", () => {
    const contract = { path: "contexts/x/src/application/a/f/f.contract.ts", text: "/**\n * Time.\n * @implementedBy system\n */\nexport interface Clock { now(): string }\n" };
    const suite = { path: "contexts/x/src/application/a/f/f.clock.test-support.ts", text: 'import type { Clock } from "./f.contract.ts";\nexport function clockConformance() {}\n' };
    const adapter = { path: "contexts/x/src/adapters/out/system/clock.ts", text: 'import type { Clock } from "../../../application/a/f/f.contract.ts";\nexport class SystemClock implements Clock {}\n' };
    const runner = { path: "contexts/x/src/adapters/out/system/clock.test.ts", text: 'import { clockConformance } from "../../../application/a/f/f.clock.test-support.ts";\nclockConformance();\n' };
    expect(implementedByViolations([contract, suite, adapter, runner], new Map())).toEqual([]);
    expect(implementedByViolations([contract, suite, adapter], new Map())).toEqual(["contexts/x/src/adapters/out/system/clock.ts — SystemClock implements Clock; a test beside it runs the port's conformance suite"]);
    expect(implementedByViolations([contract, adapter, runner], new Map())).toEqual(["contexts/x/src/application/a/f/f.contract.ts — Clock has no conformance suite: add a *.test-support.ts beside the contract that every adapter of it runs"]);
    expect(implementedByViolations([contract, suite], new Map())).toEqual(["contexts/x/src/application/a/f/f.contract.ts — Clock says it is implemented by system, but no class under adapters/out/system/ implements it"]);
    expect(implementedByViolations([contract], new Map(), new Map([["Clock", "a reason"]]))).toEqual([]);
  });

  test("R3: a domain concept is a contract, an implementation and a test, and a value object has a laws test", () => {
    const vo = "export interface Role { readonly __brand: \"Role\"; equals(other: Role): boolean }\nexport interface RoleFactory { parse(raw: unknown): Result<Role> }\n";
    const at = (name: string) => `contexts/x/src/domain/events/${name}`;
    const all = [at("role.ts"), at("role.contract.ts"), at("role.test.ts"), at("role.laws.test.ts")];
    expect(conceptTripletViolations(all, new Map([[at("role.contract.ts"), vo]]))).toEqual([]);
    expect(conceptTripletViolations(all.slice(0, 3), new Map([[at("role.contract.ts"), vo]]))).toEqual([`${at("role.contract.ts")} — a value object's laws run in role.laws.test.ts`]);
    expect(conceptTripletViolations([at("loose.ts")], new Map())).toEqual([
      `${at("loose.ts")} — a domain concept is a contract, an implementation and a test: add loose.contract.ts`,
      `${at("loose.ts")} — a domain concept is a contract, an implementation and a test: add loose.test.ts`,
    ]);
    expect(conceptTripletViolations([at("types.contract.ts")], new Map())).toEqual([`${at("types.contract.ts")} — a contract with no implementation: add types.ts, or fold its types into the contract they belong to`]);
    expect(conceptTripletViolations([at("loose.ts")], new Map(), new Map([[at("loose.ts"), "a reason"]]))).toEqual([]);
    expect(conceptTripletViolations(["contexts/x/src/packs/gate/matching.ts"], new Map())).toEqual([]);
  });

  test("R7: a shipped pack's directory holds its overview, contract, index and their test, and only domain/, application/ and adapters/", () => {
    const dir = "contexts/x/src/packs/gate";
    const tidy = [`${dir}/gate.pack.ts`, `${dir}/gate.contract.ts`, `${dir}/gate.pack.test.ts`, `${dir}/index.ts`, `${dir}/domain/rule.ts`, `${dir}/application/judge/judge.ts`, `${dir}/adapters/out/file-system/files.ts`];
    expect(packLayoutViolations(tidy)).toEqual([]);
    expect(packLayoutViolations([...tidy, `${dir}/helpers.ts`, `${dir}/lib/x.ts`])).toEqual([
      `${dir}/helpers.ts — a pack's directory holds its overview, contract, index and their test at its root, and everything else in domain/, application/ or adapters/`,
      `${dir}/lib/x.ts — a pack's directory holds its overview, contract, index and their test at its root, and everything else in domain/, application/ or adapters/`,
    ]);
    expect(packLayoutViolations([`${dir}/index.ts`])).toEqual([`${dir} — a shipped pack has gate.pack.ts`, `${dir} — a shipped pack has gate.contract.ts`]);
  });

  test("R7: an overview binds imported names in definePack's sections, in order, typed by its contract", () => {
    const path = "contexts/x/src/packs/gate/gate.pack.ts";
    const head = 'import { contribution, corePack, definePack } from "bounded/domain";\nimport { judge } from "./application/judge/judge.ts";\nimport { gateId } from "./domain/gate-id.ts";\nimport type { Gate } from "./gate.contract.ts";\n';
    const overview = (body: string, more = "") => ({ path, text: `${head}${more}export const gate: Gate = definePack({ ${body} });\n` });
    expect(packOverviewViolations([overview("id: gateId, dependsOn: [corePack], contributes: [contribution(corePack.points.effectGuards.read, [judge])]")])).toEqual([]);
    expect(packOverviewViolations([overview("id: gateId, contributes: [contribution(corePack.points.effectGuards.read, [() => judge])]")])).toEqual([`${path}:5 — an overview binds imported names only: no functions, conditionals, operators or literal text`]);
    expect(packOverviewViolations([overview("dependsOn: [corePack], id: gateId")])).toEqual([`${path} — an overview's sections are id, dependsOn, points, contributes, ports, in that order (it gives dependsOn, id)`]);
    expect(packOverviewViolations([overview("id: gateId", 'import { files } from "./adapters/out/file-system/files.ts";\n')])).toEqual([`${path}:5 — an overview imports only its domain/, application/, its contract and bounded/domain, never "./adapters/out/file-system/files.ts"`]);
    expect(packOverviewViolations([{ path: "contexts/x/src/packs/gate/domain/extra.ts", text: 'import { definePack } from "bounded/domain";\nexport const extra = definePack({ id: x });\n' }])).toEqual(["contexts/x/src/packs/gate/domain/extra.ts:2 — a pack is defined in its overview file, <name>.pack.ts"]);
  });

  test("R4: a feature has a contract, and its handler implements the in port from it", () => {
    const dir = "contexts/x/src/application/area/feature";
    const handler = 'import type { Feature } from "./feature.contract.ts";\nexport class FeatureHandler implements Feature {}\n';
    const paths = [`${dir}/feature.contract.ts`, `${dir}/feature.handler.ts`];
    expect(featureContractViolations(paths, new Map([[`${dir}/feature.handler.ts`, handler]]))).toEqual([]);
    expect(featureContractViolations([`${dir}/feature.handler.ts`], new Map([[`${dir}/feature.handler.ts`, handler]]))).toEqual([`${dir} — a feature declares its ports in feature.contract.ts`]);
    expect(featureContractViolations(paths, new Map([[`${dir}/feature.handler.ts`, "export class FeatureHandler {}\n"]]))).toEqual([`${dir}/feature.handler.ts — the handler implements its feature's in port from feature.contract.ts`]);
  });

  test("R5: a routing file has exactly the type assertions it is allowed", () => {
    const file = { path: "contexts/x/src/domain/guards/route.ts", text: "const a = b as C;\nconst d = <E>f;\nconst g = h!;\nconst k = [1] as const;\n" };
    const clean = { path: "contexts/x/src/domain/guards/clean.ts", text: "const k = [1] as const;\nconst a: C = b;\n" };
    expect(assertionViolations([file, clean], new Map([[clean.path, 0]]))).toEqual([]);
    expect(assertionViolations([file], new Map([[file.path, 3]]))).toEqual([]);
    expect(assertionViolations([file], new Map([[file.path, 0]]))).toEqual([`${file.path} — 3 type assertions (as, <T>x, !, @ts-ignore) at line 1, 2, 3; it may have 0`]);
    const silenced = { path: "contexts/x/src/domain/guards/quiet.ts", text: "// @ts-expect-error\nconst a: number = \"x\";\n" };
    expect(assertionViolations([silenced], new Map([[silenced.path, 0]]))).toEqual([`${silenced.path} — 1 type assertions (as, <T>x, !, @ts-ignore) at line 1; it may have 0`]);
    expect(assertionViolations([], new Map([[file.path, 0]]))).toEqual([`${file.path} — named by the assertion rule but missing`]);
  });

  test("R6: a shape check appears only where its shape is owned, or with a stated reason", () => {
    const at = (name: string) => `contexts/x/src/domain/area/${name}`;
    const check = "if (!Array.isArray(raw) || typeof raw === \"object\" || raw instanceof Thing) return;\n";
    const owner = { path: at("owner.ts"), text: `class OwnerImpl {\n  private constructor() {}\n  static parse(raw: unknown) {\n    ${check}  }\n}\n` };
    const loose = { path: at("loose.ts"), text: `export function decide(raw: unknown) {\n  ${check}}\n` };
    const thrown = { path: at("thrown.ts"), text: "export const text = (e: unknown) => (e instanceof Error ? e.message : String(e));\n" };
    const command = { path: "contexts/x/src/application/area/feature/feature.command.ts", text: check };
    const adapter = { path: "contexts/x/src/adapters/out/file-system/thing.ts", text: check };
    expect(shapeCheckViolations([owner, thrown, command, adapter])).toEqual([]);
    expect(shapeCheckViolations([loose])).toEqual([`${at("loose.ts")}:2,2,2 — a shape check belongs in the parse or factory of the class that owns the shape (AGENTS.md, ADR 2026-013)`]);
    expect(shapeCheckViolations([loose], new Map([[at("loose.ts"), "a reason"]]))).toEqual([]);
  });

  test("brands stay in their contracts: a barrel never exports one", () => {
    const barrel = (text: string) => ({ path: "contexts/x/src/domain/index.ts", text });
    expect(brandExportViolations([barrel('export { Thing } from "./thing.ts";\nexport type { ThingJSON } from "./thing.contract.ts";\n')])).toEqual([]);
    expect(brandExportViolations([barrel('export type { thingBrand } from "./thing.contract.ts";\n')])).toEqual(["contexts/x/src/domain/index.ts — thingBrand is a brand: it stays in its contract, never in a barrel"]);
    expect(brandExportViolations([barrel('export * from "./thing.contract.ts";\n')])).toEqual(["contexts/x/src/domain/index.ts — a barrel names what it exports, so it never passes on a brand"]);
  });

  test("layers, dependencies and I/O follow the rules", () => {
    expect(violations).toEqual([]);
  });
});
