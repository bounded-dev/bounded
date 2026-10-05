// The app-database obligation (issue #52, ADR 2026-072), contributed to the ts
// pack's `testObligations` socket at green. In a project that persists
// through Drizzle, every app smoke test (ts-hexagonal's
// `composition-root.test.ts`) must start its own migrated Postgres through the
// generated support before it composes the app:
//
//   · `useAppDatabase()` as the first statement after the imports, with
//     `useAppDatabase` imported (not type-only) from
//     `./app-test-database.test-support.ts`, so its hook is registered before
//     any other. A call in dead code, in a function nobody calls, behind a
//     short-circuit or inside a test is not one;
//   · value imports (and side-effect, dynamic or required ones) only of
//     bun:test, the generated support and the composition root; types from
//     anywhere;
//   · a `compose…` name only inside a callback passed to `test`/`it` or a
//     hook (registered after the support's, which comes first), or inside a
//     top-level function declaration whose every reference is a direct call
//     from such a place. Structural, so no call form (`.call`, `map(make)`,
//     a promise, an alias, a helper called at load) evades it: there, it runs
//     after the support has set DATABASE_URL.
//
// Static, like ts-hexagonal's smokeTestProblem: an AST walk of the test's own
// source. Green and deliver check it before the suite runs, so a smoke test
// that would reach for a database it did not start never runs at all.

import { posix } from "node:path";
import ts from "typescript";
import type { ObligationGap, ObligationInput, TestObligation } from "../../ts/pack.ts";
import { SMOKE_TEST } from "../../ts-hexagonal/scripts/obligations.ts";
import { APP_TEST_DATABASE, CONTEXT_KIND, USE_APP_DATABASE } from "./emit.ts";
import { readStoreFeatures } from "./store-features.ts";

const SUPPORT = /^\.\/app-test-database\.test-support(?:\.[cm]?[jt]s)?$/;
const COMPOSE = /^compose[A-Z0-9]/;

/** The name `useAppDatabase` is bound to by a value import from the generated support, if any. */
function supportBinding(file: ts.SourceFile): string | undefined {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!SUPPORT.test(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly && (element.propertyName ?? element.name).text === USE_APP_DATABASE) return element.name.text;
    }
  }
  return undefined;
}

/** Is `statement` the expression statement `name()`? */
const isCallOf = (statement: ts.Statement | undefined, name: string): boolean =>
  statement !== undefined && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
  ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === name;

/** A top-level `name()` expression statement anywhere. */
function calledAtTopLevel(file: ts.SourceFile, name: string): boolean {
  return file.statements.some((statement) => isCallOf(statement, name));
}

/** Is the first statement after the imports `name()`? */
function calledFirst(file: ts.SourceFile, name: string): boolean {
  return isCallOf(file.statements.find((statement) => !ts.isImportDeclaration(statement)), name);
}

/** The identifier at the root of a callee: `test` for `test`, `test.skip`
 *  and `test.each(table)`. */
function calleeRoot(callee: ts.Expression): string | undefined {
  let at: ts.Expression = callee;
  while (ts.isCallExpression(at) || ts.isPropertyAccessExpression(at) || ts.isParenthesizedExpression(at)) at = at.expression;
  return ts.isIdentifier(at) ? at.text : undefined;
}

/** What a smoke test may import with a value: the test runner, the generated
 *  support and its app's composition root. Types may come from anywhere. */
const ALLOWED_MODULES = [/^bun:test$/, SUPPORT, /^\.\/composition-root(?:\.[cm]?[jt]s)?$/];
const ALLOWED_IMPORTS = "a smoke test imports only bun:test, ./app-test-database.test-support.ts and ./composition-root.ts (types from anywhere)";

/** The first module imported with a value (or for its side effects) that a
 *  smoke test may not import, including a dynamic import or require. */
function disallowedImport(file: ts.SourceFile): string | undefined {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const typesOnly = clause !== undefined && (clause.isTypeOnly ||
      (clause.name === undefined && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly)));
    const spec = statement.moduleSpecifier.text;
    if (!typesOnly && !ALLOWED_MODULES.some((allowed) => allowed.test(spec))) return spec;
  }
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const arg = node.arguments[0];
      found = arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : "a computed module";
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Callbacks that run at test time: those passed to a test or a hook. */
const RUNS_IN_A_TEST = new Set(["test", "it", "beforeAll", "beforeEach", "afterAll", "afterEach"]);

function isTestCallback(fn: ts.Node): boolean {
  let outer: ts.Node = fn;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const call = outer.parent;
  if (call === undefined || !ts.isCallExpression(call) || !call.arguments.includes(outer as ts.Expression)) return false;
  const root = calleeRoot(call.expression);
  return root !== undefined && RUNS_IN_A_TEST.has(root);
}

const insideAny = (node: ts.Node, holds: (ancestor: ts.Node) => boolean): boolean => {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) if (holds(at)) return true;
  return false;
};

const inTypePosition = (node: ts.Node): boolean => insideAny(node, (at) => ts.isTypeNode(at));

/**
 * The first `compose…` name that appears outside a test or hook callback.
 * Structural, so no call form evades it: a compose name may appear only
 * inside a callback passed to `test`/`it` or a hook (registered after
 * `useAppDatabase()`, which comes first), or inside a top-level function
 * declaration whose every reference is a direct call from such a place.
 * Types (`ReturnType<typeof composeApp>`) do not count.
 */
function composeOutsideTests(file: ts.SourceFile): string | undefined {
  const declarations = new Map<string, ts.FunctionDeclaration>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) {
      declarations.set(statement.name.text, statement);
    }
  }
  const references: ts.Identifier[] = [];
  const composeNames: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      if (declarations.has(node.text) && !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node)) references.push(node);
      if (COMPOSE.test(node.text) && !inTypePosition(node)) composeNames.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  // Allowed helpers, to a fixpoint: every reference a direct call from a
  // test callback or another allowed helper.
  const allowed = new Set<ts.Node>();
  const inAllowed = (node: ts.Node): boolean => insideAny(node, (at) => (ts.isFunctionLike(at) && isTestCallback(at)) || allowed.has(at));
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, fn] of declarations) {
      if (allowed.has(fn)) continue;
      const refs = references.filter((r) => r.text === name);
      if (refs.length > 0 && refs.every((r) => ts.isCallExpression(r.parent) && r.parent.expression === r && inAllowed(r))) {
        allowed.add(fn);
        changed = true;
      }
    }
  }
  const outside = composeNames.find((node) => !inAllowed(node));
  return outside === undefined ? undefined : (outside as ts.Identifier).text;
}

/** Undefined when the smoke test starts its own database before it composes;
 *  otherwise the gap's wording. Pure. */
export function appDatabaseProblem(path: string, source: string): string | undefined {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const local = supportBinding(file);
  if (local === undefined) {
    return `${path} does not import ${USE_APP_DATABASE} from ./${APP_TEST_DATABASE}, the generated support that starts the app's own database`;
  }
  if (!calledAtTopLevel(file, local)) {
    return `${path} never calls ${USE_APP_DATABASE}() at its top level; call it once there, before any test, so the app's own database is up`;
  }
  if (!calledFirst(file, local)) {
    return `${path} must call ${USE_APP_DATABASE}() as its first statement after the imports, so its database starts before ` +
      "anything else the file registers can compose the app";
  }
  const imported = disallowedImport(file);
  if (imported !== undefined) return `${path} imports ${imported}; ${ALLOWED_IMPORTS}`;
  const composed = composeOutsideTests(file);
  if (composed !== undefined) {
    return `${path} names ${composed} outside a test or a hook; compose the app only inside a test or a hook callback ` +
      `(or a function declaration only those call), after ${USE_APP_DATABASE}() has pointed DATABASE_URL at the app's own database`;
  }
  return undefined;
}

function appDatabaseGaps(input: ObligationInput): ObligationGap[] {
  const persists = input.facts.workspaces.some((w) => w.kind === CONTEXT_KIND && readStoreFeatures(w).length > 0);
  if (!persists) return [];
  const gaps: ObligationGap[] = [];
  for (const app of input.facts.workspaces.filter((w) => w.kind !== CONTEXT_KIND)) {
    const root = input.facts.workspaceTemplates.find((t) => t.kind === app.kind)?.compositionRoot;
    if (root === undefined) continue;
    const smoke = `${posix.dirname(`${app.dir}/${root}`)}/${SMOKE_TEST}`;
    const test = input.tests.find((t) => t.path === smoke);
    if (test === undefined) continue; // ts-hexagonal names a missing smoke test
    const problem = appDatabaseProblem(smoke, test.source);
    if (problem !== undefined) gaps.push({ level: "app", path: smoke, message: problem });
  }
  return gaps;
}

export const appDatabaseObligation: TestObligation = {
  name: "drizzle-app-database",
  description: "Per app of a project that persists through Drizzle, at green: its smoke test calls useAppDatabase() from the generated support at its top level, and composes the app only inside a test or a hook.",
  phases: ["green"],
  check: appDatabaseGaps,
};
