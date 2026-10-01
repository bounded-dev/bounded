// What a test file exercises, read from its source (issue #36).
//
// A test's SUBJECTS are the imported values it reaches: the imports its body
// names, plus those reached through what it names that is declared outside it
// (a module helper, a `describe`-level fixture, a variable a `beforeEach`
// assigns), plus modules it loads with a literal `import()`. Type positions
// never count. Each subject is classified by a resolver: generated (a module
// only generators write, ADR 2026-058), authored (code a role writes), none
// (a library, the test runner, a generated test helper), or unknown.
//
// A test whose subjects are all generated cannot fail for the right reason at
// red: generated code works before anything is built, and its generated laws
// (`*.laws.test.ts`) already test it. Two places ask that question: the
// `no-generated-subject` test lint, before the suite runs, and the red gate,
// to explain a test that passed against the skeletons. Both use this module,
// so they cannot disagree about which test touched what.
//
// THE RULE IS ONE-SIDED: WHEN UNSURE, NEVER CALL A TEST GENERATED-ONLY. A
// refusal tells the test-writer to delete a test, so every route the analysis
// cannot see through counts as possibly authored ("unknown"): a value that
// arrives as a parameter (a conformance suite's factory), a global it does
// not know, a computed `import(x)`, a `require()`, an `export *` it would
// have to expand, a chain too deep to follow. A test-side helper the test
// imports (a fixture in a `.test-support.ts` file) is followed into its own
// subjects, so a fixture that builds a handler makes the test the handler's.
//
// The analysis is generic: which files are generated comes from the composed
// packs' `generatedFileGlobs`, which files are test-side from their
// `testFileSuffixes`, how a package name resolves from the workspace
// manifests' `exports`. It names no technology.

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parseForESLint } from "@typescript-eslint/parser";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { generatedFileGlobs, hasTestFileSuffix, pathGlobMatcher, sourceRoots, testFileSuffixes } from "../../../src/pack-contrib.ts";
import { expandSourceRoots } from "../../../src/path-gate.ts";

/** One imported value: `import { CreateNoteCommand } from "./create-note.command.ts"`,
 *  a named re-export, or a module loaded by a literal `import()`. */
export interface ImportedValue {
  readonly spec: string;
  /** The exported name it binds: a name, `default`, or `*` for a whole module. */
  readonly name: string;
  readonly local: string;
  readonly node: TSESTree.Node;
}

/** What some code reaches: imported values, and whether it also reaches
 *  something the analysis cannot see through (`unknown` says what). */
export interface Reach {
  readonly values: readonly ImportedValue[];
  readonly unknown?: string;
}

/** One `test(…)` / `it(…)` call and what its body reaches. */
export interface TestCase {
  /** `describe > … > test`, as bun reports it; undefined when a name is not a literal. */
  readonly name: string | undefined;
  readonly node: TSESTree.Node;
  readonly reach: Reach;
}

export interface TestFileSubjects {
  /** Every value import of the file. */
  readonly imports: readonly ImportedValue[];
  readonly tests: readonly TestCase[];
  /** What the file's export `name` reaches; unknown when it cannot tell. */
  readonly exported: (name: string) => Reach;
}

type Scope = TSESLint.Scope.Scope;
type Variable = TSESLint.Scope.Variable;
type Reference = TSESLint.Scope.Reference;

const TEST_CALLEES = new Set(["test", "it"]);
const SUITE_CALLEES = new Set(["describe"]);

/** Globals that are never a subject: the language's and the runtime's own,
 *  and the test runner's (bun also provides them without an import). */
const KNOWN_GLOBALS: ReadonlySet<string> = new Set([
  ...Object.getOwnPropertyNames(globalThis),
  "describe", "test", "it", "expect", "beforeEach", "afterEach", "beforeAll", "afterAll", "mock", "spyOn", "jest", "Bun",
]);

/** The identifier a test-runner call bottoms out at: `test`, `test.only`,
 *  `test.each(rows)`, `describe.skipIf(x)`. */
function runnerName(callee: TSESTree.Node): string | undefined {
  let node: TSESTree.Node = callee;
  for (;;) {
    if (node.type === "Identifier") return node.name;
    if (node.type === "MemberExpression" && !node.computed) node = node.object;
    else if (node.type === "CallExpression") node = node.callee;
    else return undefined;
  }
}

function literalName(node: TSESTree.Node | null | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]!.value.cooked ?? undefined;
  return undefined;
}

const isFunction = (node: TSESTree.Node | undefined): node is TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression =>
  node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";

const exportedName = (node: TSESTree.Identifier | TSESTree.StringLiteral): string =>
  node.type === "Identifier" ? node.name : String(node.value);

function isNode(value: unknown): value is TSESTree.Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function walk(node: TSESTree.Node, visit: (node: TSESTree.Node) => boolean): void {
  if (!visit(node)) return;
  for (const key of Object.keys(node) as (keyof typeof node)[]) {
    if (key === "parent") continue;
    const child = node[key] as unknown;
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) walk(item, visit);
    } else if (isNode(child)) {
      walk(child, visit);
    }
  }
}

/** Read one test file's value imports, its tests' reach and its exports' reach. */
export function analyseTestFile(ast: TSESTree.Program, manager: TSESLint.Scope.ScopeManager): TestFileSubjects {
  const imports: ImportedValue[] = [];
  const byVariable = new Map<Variable, ImportedValue>();
  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue;
      const name = specifier.type === "ImportDefaultSpecifier" ? "default"
        : specifier.type === "ImportNamespaceSpecifier" ? "*"
        : exportedName(specifier.imported);
      const value: ImportedValue = { spec: statement.source.value, name, local: specifier.local.name, node: specifier };
      imports.push(value);
      for (const variable of manager.getDeclaredVariables(specifier)) byVariable.set(variable as Variable, value);
    }
  }

  // Runtime loads: a literal `import("x")` loads module x whole; anything
  // else loaded at runtime cannot be followed. `require()` is not read: its
  // callee is an unknown global, which makes the code that calls it unknown.
  const loads: { node: TSESTree.ImportExpression; spec: string | undefined }[] = [];
  walk(ast, (node) => {
    if (node.type === "ImportExpression") loads.push({ node, spec: literalName(node.source) });
    return true;
  });

  const references: Reference[] = (manager.scopes as Scope[]).flatMap((scope) => scope.references as Reference[]);
  const within = (node: TSESTree.Node, range: readonly [number, number]): boolean => node.range[0] >= range[0] && node.range[1] <= range[1];

  const memo = new Map<Variable, Reach>();
  const reached = (range: readonly [number, number], visiting: Set<Variable>): Reach => {
    const values = new Set<ImportedValue>();
    let unknown: string | undefined;
    const add = (reach: Reach): void => {
      for (const value of reach.values) values.add(value);
      unknown ??= reach.unknown;
    };
    for (const load of loads) {
      if (!within(load.node, range)) continue;
      if (load.spec === undefined) unknown ??= "a module loaded by a computed import()";
      else values.add({ spec: load.spec, name: "*", local: `import("${load.spec}")`, node: load.node });
    }
    for (const reference of references) {
      if (!within(reference.identifier, range) || !reference.isValueReference) continue;
      const variable = reference.resolved as Variable | null;
      if (variable === null) {
        if (!KNOWN_GLOBALS.has(reference.identifier.name)) unknown ??= `the global '${reference.identifier.name}'`;
        continue;
      }
      const imported = byVariable.get(variable);
      if (imported !== undefined) {
        values.add(imported);
        continue;
      }
      // The language's own library (`Promise`, `Map`): no declaration to read.
      if (variable.defs.length === 0) continue;
      // Declared inside the range: the range's own local, already walked.
      if (variable.defs.every((def) => within(def.name, range))) continue;
      add(throughVariable(variable, visiting));
    }
    return unknown === undefined ? { values: [...values] } : { values: [...values], unknown };
  };
  const throughVariable = (variable: Variable, visiting: Set<Variable>): Reach => {
    const known = memo.get(variable);
    if (known !== undefined) return known;
    if (visiting.has(variable)) return { values: [] };
    visiting.add(variable);
    const ranges: (readonly [number, number])[] = [];
    let unknown: string | undefined;
    for (const def of variable.defs) {
      if (def.type === "Variable") {
        const declarator = def.node as TSESTree.VariableDeclarator;
        if (declarator.init !== null) ranges.push(declarator.init.range);
      } else if (def.type === "FunctionName" || def.type === "ClassName" || def.type === "TSEnumName") {
        ranges.push(def.node.range);
      } else {
        // A parameter (a conformance suite's factory), a catch binding: what
        // it holds is decided by a caller this analysis does not follow.
        unknown ??= def.type === "Parameter" ? `the parameter '${variable.name}'` : `'${variable.name}'`;
      }
    }
    for (const reference of variable.references as Reference[]) {
      const written = reference.writeExpr as TSESTree.Node | null | undefined;
      if (reference.isWrite() && written !== null && written !== undefined) ranges.push(written.range);
    }
    // `declare const x`, or a `let` nothing visible assigns: set elsewhere.
    if (ranges.length === 0 && unknown === undefined) unknown = `'${variable.name}', assigned nowhere the analysis can see`;
    const values = new Set<ImportedValue>();
    for (const range of ranges) {
      const reach = reached(range, visiting);
      for (const value of reach.values) values.add(value);
      unknown ??= reach.unknown;
    }
    visiting.delete(variable);
    const result: Reach = unknown === undefined ? { values: [...values] } : { values: [...values], unknown };
    memo.set(variable, result);
    return result;
  };

  const tests: TestCase[] = [];
  const visitTests = (node: TSESTree.Node, suites: readonly (string | undefined)[]): void => {
    walk(node, (child) => {
      if (child.type !== "CallExpression") return true;
      const callee = runnerName(child.callee);
      const body = [...child.arguments].reverse().find((a) => isFunction(a));
      if (callee === undefined || body === undefined || !(TEST_CALLEES.has(callee) || SUITE_CALLEES.has(callee))) return true;
      const chain = [...suites, literalName(child.arguments[0])];
      if (TEST_CALLEES.has(callee)) {
        const name = chain.every((s) => s !== undefined) ? chain.join(" > ") : undefined;
        tests.push({ name, node: child, reach: reached(body.range, new Set()) });
      } else {
        visitTests(body.body, chain);
      }
      return false;
    });
  };
  visitTests(ast, []);

  const moduleScope = (manager.scopes as Scope[]).find((s) => s.type === "module") ?? (manager.scopes as Scope[])[0];
  const throughLocal = (local: string): Reach => {
    const variable = moduleScope?.set.get(local) as Variable | undefined;
    if (variable === undefined) return { values: [], unknown: `'${local}'` };
    const imported = byVariable.get(variable);
    return imported !== undefined ? { values: [imported] } : throughVariable(variable, new Set());
  };
  const exported = (name: string): Reach => {
    let starred = false;
    for (const statement of ast.body) {
      if (statement.type === "ExportNamedDeclaration") {
        if (statement.declaration !== null && statement.declaration !== undefined) {
          for (const variable of manager.getDeclaredVariables(statement.declaration) as Variable[]) {
            if (variable.name === name) return throughVariable(variable, new Set());
          }
        }
        for (const specifier of statement.specifiers) {
          if (exportedName(specifier.exported) !== name) continue;
          const local = exportedName(specifier.local);
          return statement.source !== null
            ? { values: [{ spec: statement.source.value, name: local, local: name, node: specifier }] }
            : throughLocal(local);
        }
      } else if (statement.type === "ExportDefaultDeclaration" && name === "default") {
        const declaration = statement.declaration;
        return declaration.type === "Identifier" ? throughLocal(declaration.name) : reached(declaration.range, new Set());
      } else if (statement.type === "ExportAllDeclaration") {
        starred = true;
      }
    }
    // `export *` would need every source's exports expanded; not followed.
    return { values: [], unknown: starred ? `'${name}', re-exported by export *` : `'${name}', not found among the exports` };
  };

  return { imports, tests, exported };
}

/** analyseTestFile() over source text. */
export function analyseTestSource(source: string, path: string): TestFileSubjects {
  const { ast, scopeManager } = parseForESLint(source, { filePath: path, range: true, loc: true, jsx: /\.tsx$/i.test(path) });
  return analyseTestFile(ast as TSESTree.Program, scopeManager as unknown as TSESLint.Scope.ScopeManager);
}

// --- Which subjects are generated ------------------------------------------------

export type SubjectKind = "generated" | "authored" | "none" | "unknown";

/** Classifies an imported value, seen from a project-relative file. */
export type SubjectResolver = (fromFile: string, spec: string, name: string) => SubjectKind;

/** The kind of several subjects together: unknown wins, then authored. */
export function combineKinds(kinds: readonly SubjectKind[]): SubjectKind {
  for (const kind of ["unknown", "authored", "generated"] as const) if (kinds.includes(kind)) return kind;
  return "none";
}

interface Workspace {
  readonly dir: string;
  readonly exports: Readonly<Record<string, string>>;
}

/** Re-exports of a module made only of re-exports (a barrel); undefined when
 *  it declares anything of its own. */
function barrelExports(text: string, path: string): { names: Map<string, string>; all: string[] } | undefined {
  let ast: TSESTree.Program;
  try {
    ast = parseForESLint(text, { filePath: path, range: true }).ast as TSESTree.Program;
  } catch {
    return undefined;
  }
  const names = new Map<string, string>();
  const all: string[] = [];
  for (const statement of ast.body) {
    if (statement.type === "ExportNamedDeclaration" && statement.source !== null && statement.declaration === null) {
      if (statement.exportKind === "type") continue;
      for (const specifier of statement.specifiers) {
        if (specifier.exportKind === "type") continue;
        names.set(exportedName(specifier.exported), statement.source.value);
      }
    } else if (statement.type === "ExportAllDeclaration") {
      if (statement.exportKind !== "type") all.push(statement.source.value);
    } else {
      return undefined;
    }
  }
  return { names, all };
}

const MAX_DEPTH = 8;

/**
 * The resolver for a project: generated means a path a composed
 * `generatedFileGlobs` entry matches; a generated barrel is followed to the
 * module that defines the imported name; an authored test-side helper is
 * followed into what its export reaches; a generated test-side helper (a
 * test database) and anything outside the project are none. An unreadable
 * composition classifies everything as unknown, so nothing is refused.
 */
export function subjectResolver(cwd: string, packsDir?: string): SubjectResolver {
  let isGenerated: (path: string) => boolean;
  let suffixes: string[];
  let roots: string[];
  try {
    isGenerated = pathGlobMatcher(generatedFileGlobs(cwd, packsDir));
    suffixes = testFileSuffixes(cwd, packsDir);
    roots = expandSourceRoots(cwd, sourceRoots(cwd, packsDir));
  } catch {
    return () => "unknown";
  }
  const workspaces = new Map<string, Workspace>();
  for (const root of roots) {
    const dir = root.split("/").slice(0, -1).join("/");
    try {
      const manifest = JSON.parse(readFileSync(join(cwd, dir, "package.json"), "utf8")) as { name?: unknown; exports?: unknown };
      if (typeof manifest.name !== "string") continue;
      const exports: Record<string, string> = {};
      if (typeof manifest.exports === "object" && manifest.exports !== null) {
        for (const [key, target] of Object.entries(manifest.exports)) if (typeof target === "string") exports[key] = target;
      }
      workspaces.set(manifest.name, { dir, exports });
    } catch {
      // A workspace without a readable manifest exports nothing.
    }
  }

  const fileOf = (fromFile: string, spec: string): string | undefined => {
    let path: string | undefined;
    if (spec.startsWith(".")) {
      path = posix.normalize(posix.join(posix.dirname(fromFile), spec));
      if (path.startsWith("..")) return undefined;
    } else {
      const parts = spec.split("/");
      const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
      const workspace = workspaces.get(name);
      if (workspace === undefined) return undefined;
      const subpath = parts.slice(spec.startsWith("@") ? 2 : 1).join("/");
      const target = workspace.exports[subpath === "" ? "." : `./${subpath}`];
      if (target === undefined) return undefined;
      path = posix.normalize(posix.join(workspace.dir, target));
    }
    if (existsSync(join(cwd, path)) || /\.[cm]?[jt]sx?$/.test(path)) return path;
    for (const candidate of [`${path}.ts`, `${path}.tsx`, `${path}/index.ts`]) if (existsSync(join(cwd, candidate))) return candidate;
    return path;
  };

  const helpers = new Map<string, TestFileSubjects | undefined>();
  const helper = (path: string): TestFileSubjects | undefined => {
    if (!helpers.has(path)) {
      try {
        helpers.set(path, analyseTestSource(readFileSync(join(cwd, path), "utf8"), path));
      } catch {
        helpers.set(path, undefined);
      }
    }
    return helpers.get(path);
  };

  const kindOf = (path: string, name: string, depth: number): SubjectKind => {
    if (depth > MAX_DEPTH) return "unknown";
    if (hasTestFileSuffix(path, suffixes)) {
      if (isGenerated(path)) return "none";
      const analysis = helper(path);
      if (analysis === undefined || name === "*") return "unknown";
      const reach = analysis.exported(name);
      if (reach.unknown !== undefined) return "unknown";
      return combineKinds(reach.values.map((v) => classify(path, v.spec, v.name, depth + 1)));
    }
    if (!isGenerated(path)) return "authored";
    let text: string;
    try {
      text = readFileSync(join(cwd, path), "utf8");
    } catch {
      return "generated";
    }
    const barrel = barrelExports(text, path);
    if (barrel === undefined) return "generated";
    // A whole barrel may reach anything.
    if (name === "*" || name === "default") return "unknown";
    const from = barrel.names.get(name);
    if (from !== undefined) return classify(path, from, name, depth + 1);
    const kinds = barrel.all.map((spec) => fileOf(path, spec)).filter((p) => p !== undefined).map((p) => kindOf(p, name, depth + 1));
    return kinds.length === 0 ? "unknown" : combineKinds(kinds);
  };
  const classify = (fromFile: string, spec: string, name: string, depth: number): SubjectKind => {
    const path = fileOf(fromFile, spec);
    return path === undefined ? "none" : kindOf(path, name, depth);
  };

  return (fromFile, spec, name) => classify(fromFile, spec, name, 0);
}

/** A subject as a reader names it: `CreateNoteCommand from ./create-note.command.ts`. */
export function subjectLabel(value: ImportedValue): string {
  return `${value.name === "*" || value.name === "default" ? value.local : value.name} from ${value.spec}`;
}

/** The subjects of some code that are project code, when every one of them
 *  is generated; undefined when it reaches authored code, no project code,
 *  or anything the analysis cannot see through. */
export function onlyGenerated(reach: Reach, fromFile: string, resolve: SubjectResolver): readonly ImportedValue[] | undefined {
  if (reach.unknown !== undefined) return undefined;
  const project = reach.values.map((s) => ({ s, kind: resolve(fromFile, s.spec, s.name) })).filter((x) => x.kind !== "none");
  return project.length > 0 && project.every((x) => x.kind === "generated") ? project.map((x) => x.s) : undefined;
}

/** A test that exercises only generated code: its name, line and subjects. */
export interface GeneratedOnlyTest {
  readonly line: number;
  readonly subjects: readonly ImportedValue[];
}

/** The tests of one file that exercise only generated code, by bun's name. */
export function generatedOnlyTests(cwd: string, file: string, resolve: SubjectResolver): Map<string, GeneratedOnlyTest> {
  const out = new Map<string, GeneratedOnlyTest>();
  let analysis: TestFileSubjects;
  try {
    analysis = analyseTestSource(readFileSync(join(cwd, file), "utf8"), file);
  } catch {
    return out;
  }
  for (const test of analysis.tests) {
    const generated = test.name === undefined ? undefined : onlyGenerated(test.reach, file, resolve);
    if (generated !== undefined) out.set(test.name!, { line: test.node.loc.start.line, subjects: generated });
  }
  return out;
}
