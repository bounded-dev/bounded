// What a test file exercises, read from its source (issue #36).
//
// A test's SUBJECTS are the imported values it reaches: the imports its body
// names, plus those reached through what it names that is declared outside it
// (a module helper, a `describe`-level fixture, a variable a `beforeEach`
// assigns). Type positions never count. Each subject is classified by a
// resolver: generated (a module only generators write, ADR 2026-058),
// authored (code a role writes), or none (a library, the test runner, a
// test-side helper such as a conformance suite).
//
// A test whose subjects are all generated cannot fail for the right reason at
// red: generated code works before anything is built, and its generated laws
// (`*.laws.test.ts`) already test it. Two places ask that question: the
// `no-generated-subject` test lint, before the suite runs, and the red gate,
// to explain a test that passed against the skeletons. Both use this module,
// so they cannot disagree about which test touched what.
//
// The analysis is generic: which files are generated comes from the composed
// packs' `generatedFileGlobs`, how a package name resolves from the
// workspace manifests' `exports`. It names no technology.

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parseForESLint } from "@typescript-eslint/parser";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { generatedFileGlobs, hasTestFileSuffix, pathGlobMatcher, sourceRoots, testFileSuffixes } from "../../../src/pack-contrib.ts";
import { expandSourceRoots } from "../../../src/path-gate.ts";

/** One imported value binding: `import { CreateNoteCommand } from "./create-note.command.ts"`. */
export interface ImportedValue {
  readonly spec: string;
  /** The exported name it binds: a name, `default`, or `*` for a namespace. */
  readonly name: string;
  readonly local: string;
  readonly node: TSESTree.Node;
}

/** One `test(…)` / `it(…)` call and what its body reaches. */
export interface TestCase {
  /** `describe > … > test`, as bun reports it; undefined when a name is not a literal. */
  readonly name: string | undefined;
  readonly node: TSESTree.Node;
  readonly subjects: readonly ImportedValue[];
}

export interface TestFileSubjects {
  /** Every value import of the file. */
  readonly imports: readonly ImportedValue[];
  readonly tests: readonly TestCase[];
}

type Scope = TSESLint.Scope.Scope;
type Variable = TSESLint.Scope.Variable;
type Reference = TSESLint.Scope.Reference;

const TEST_CALLEES = new Set(["test", "it"]);
const SUITE_CALLEES = new Set(["describe"]);

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

function literalName(node: TSESTree.Node | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]!.value.cooked ?? undefined;
  return undefined;
}

const isFunction = (node: TSESTree.Node | undefined): node is TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression =>
  node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";

function allScopes(manager: TSESLint.Scope.ScopeManager): Scope[] {
  return manager.scopes as Scope[];
}

/** Read one test file's value imports and its tests' subjects. */
export function analyseTestFile(ast: TSESTree.Program, manager: TSESLint.Scope.ScopeManager): TestFileSubjects {
  const imports: ImportedValue[] = [];
  const byVariable = new Map<Variable, ImportedValue>();
  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue;
      const name = specifier.type === "ImportDefaultSpecifier" ? "default"
        : specifier.type === "ImportNamespaceSpecifier" ? "*"
        : specifier.imported.type === "Identifier" ? specifier.imported.name : String(specifier.imported.value);
      const value: ImportedValue = { spec: statement.source.value, name, local: specifier.local.name, node: specifier };
      imports.push(value);
      for (const variable of manager.getDeclaredVariables(specifier)) byVariable.set(variable as Variable, value);
    }
  }

  const references: Reference[] = allScopes(manager).flatMap((scope) => scope.references as Reference[]);
  const within = (node: TSESTree.Node, range: readonly [number, number]): boolean => node.range[0] >= range[0] && node.range[1] <= range[1];

  const memo = new Map<Variable, ImportedValue[]>();
  const reached = (range: readonly [number, number], visiting: Set<Variable>): ImportedValue[] => {
    const out = new Set<ImportedValue>();
    for (const reference of references) {
      if (!within(reference.identifier, range) || !reference.isValueReference) continue;
      const variable = reference.resolved as Variable | null;
      if (variable === null) continue;
      const imported = byVariable.get(variable);
      if (imported !== undefined) {
        out.add(imported);
        continue;
      }
      // Declared inside the range: the range's own local, already walked.
      if (variable.defs.length > 0 && variable.defs.every((def) => within(def.name, range))) continue;
      for (const value of throughVariable(variable, visiting)) out.add(value);
    }
    return [...out];
  };
  const throughVariable = (variable: Variable, visiting: Set<Variable>): ImportedValue[] => {
    const known = memo.get(variable);
    if (known !== undefined) return known;
    if (visiting.has(variable)) return [];
    visiting.add(variable);
    const ranges: (readonly [number, number])[] = [];
    for (const def of variable.defs) {
      if (def.type === "Variable") {
        const declarator = def.node as TSESTree.VariableDeclarator;
        if (declarator.init !== null) ranges.push(declarator.init.range);
      } else if (def.type === "FunctionName" || def.type === "ClassName") {
        ranges.push(def.node.range);
      }
    }
    for (const reference of variable.references as Reference[]) {
      const written = reference.writeExpr as TSESTree.Node | null | undefined;
      if (reference.isWrite() && written !== null && written !== undefined) ranges.push(written.range);
    }
    const out = new Set<ImportedValue>();
    for (const range of ranges) for (const value of reached(range, visiting)) out.add(value);
    visiting.delete(variable);
    const result = [...out];
    memo.set(variable, result);
    return result;
  };

  const tests: TestCase[] = [];
  const visit = (node: TSESTree.Node, suites: readonly (string | undefined)[]): void => {
    if (node.type === "CallExpression") {
      const callee = runnerName(node.callee);
      const body = [...node.arguments].reverse().find((a) => isFunction(a));
      if (callee !== undefined && body !== undefined && (TEST_CALLEES.has(callee) || SUITE_CALLEES.has(callee))) {
        const own = literalName(node.arguments[0]);
        const chain = [...suites, own];
        if (TEST_CALLEES.has(callee)) {
          const name = chain.every((s) => s !== undefined) ? chain.join(" > ") : undefined;
          tests.push({ name, node, subjects: reached(body.range, new Set()) });
          return;
        }
        visit(body.body, chain);
        return;
      }
    }
    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      if (key === "parent") continue;
      const child = node[key] as unknown;
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) visit(item, suites);
      } else if (isNode(child)) {
        visit(child, suites);
      }
    }
  };
  visit(ast, []);
  return { imports, tests };
}

function isNode(value: unknown): value is TSESTree.Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** analyseTestFile() over source text. */
export function analyseTestSource(source: string, path: string): TestFileSubjects {
  const { ast, scopeManager } = parseForESLint(source, { filePath: path, range: true, loc: true, jsx: /\.tsx$/i.test(path) });
  return analyseTestFile(ast as TSESTree.Program, scopeManager as unknown as TSESLint.Scope.ScopeManager);
}

// --- Which subjects are generated ------------------------------------------------

export type SubjectKind = "generated" | "authored" | "none";

/** Classifies an imported value, seen from a project-relative file. */
export type SubjectResolver = (fromFile: string, spec: string, name: string) => SubjectKind;

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
        const exported = specifier.exported.type === "Identifier" ? specifier.exported.name : String(specifier.exported.value);
        names.set(exported, statement.source.value);
      }
    } else if (statement.type === "ExportAllDeclaration") {
      if (statement.exportKind !== "type") all.push(statement.source.value);
    } else {
      return undefined;
    }
  }
  return { names, all };
}

/**
 * The resolver for a project: generated means a path a composed
 * `generatedFileGlobs` entry matches, test-side files and anything outside
 * the project are none, and a generated barrel is followed to the module
 * that defines the imported name. An unreadable composition classifies
 * everything as none, so a check built on it says nothing rather than guess.
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
    return () => "none";
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

  const kindOf = (path: string, name: string, depth: number): SubjectKind => {
    if (hasTestFileSuffix(path, suffixes)) return "none";
    if (!isGenerated(path)) return "authored";
    let text: string;
    try {
      text = readFileSync(join(cwd, path), "utf8");
    } catch {
      return "generated";
    }
    const barrel = barrelExports(text, path);
    if (barrel === undefined) return "generated";
    // A whole barrel, or a chain too deep to follow: it may reach anything.
    if (name === "*" || name === "default" || depth > 8) return "authored";
    const from = barrel.names.get(name);
    if (from !== undefined) {
      const next = fileOf(path, from);
      return next === undefined ? "none" : kindOf(next, name, depth + 1);
    }
    const kinds = barrel.all.map((spec) => fileOf(path, spec)).filter((p) => p !== undefined).map((p) => kindOf(p, name, depth + 1));
    return kinds.includes("authored") || kinds.length === 0 ? "authored" : "generated";
  };

  return (fromFile, spec, name) => {
    const path = fileOf(fromFile, spec);
    return path === undefined ? "none" : kindOf(path, name, 0);
  };
}

/** A subject as a reader names it: `CreateNoteCommand from ./create-note.command.ts`. */
export function subjectLabel(value: ImportedValue): string {
  return `${value.name === "*" || value.name === "default" ? value.local : value.name} from ${value.spec}`;
}

/** The subjects of a test that are project code, when every one of them is
 *  generated; undefined when it reaches authored code or no project code. */
export function onlyGenerated(
  subjects: readonly ImportedValue[],
  fromFile: string,
  resolve: SubjectResolver,
): readonly ImportedValue[] | undefined {
  const project = subjects.map((s) => ({ s, kind: resolve(fromFile, s.spec, s.name) })).filter((x) => x.kind !== "none");
  return project.length > 0 && project.every((x) => x.kind === "generated") ? project.map((x) => x.s) : undefined;
}

/** The tests of one file that exercise only generated code, by bun's name. */
export function generatedOnlyTests(cwd: string, file: string, resolve: SubjectResolver): Map<string, readonly ImportedValue[]> {
  const out = new Map<string, readonly ImportedValue[]>();
  let analysis: TestFileSubjects;
  try {
    analysis = analyseTestSource(readFileSync(join(cwd, file), "utf8"), file);
  } catch {
    return out;
  }
  for (const test of analysis.tests) {
    const generated = test.name === undefined ? undefined : onlyGenerated(test.subjects, file, resolve);
    if (generated !== undefined) out.set(test.name!, generated);
  }
  return out;
}
