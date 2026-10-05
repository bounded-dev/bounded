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
//   · no `compose…()` call reachable while the file loads: at module scope,
//     in a `describe` callback (`describe.each(…)(…)` included, or a named
//     function passed as one), in a function called on the spot, or in a
//     named function any of those calls, transitively. Inside a test or a
//     hook (registered after the support's), or a function only they call,
//     it runs after the support has set DATABASE_URL.
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

const unwrap = (node: ts.Node): ts.Node => {
  let at = node;
  while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
  return at;
};

/** The identifier at the root of a callee: `describe` for `describe`,
 *  `describe.skip`, and `describe.each(table)`. */
function calleeRoot(callee: ts.Expression): string | undefined {
  let at: ts.Expression = callee;
  while (ts.isCallExpression(at) || ts.isPropertyAccessExpression(at) || ts.isParenthesizedExpression(at)) at = at.expression;
  return ts.isIdentifier(at) ? at.text : undefined;
}

/** The function a name is bound to at the top level: a declaration, or a
 *  const initialised with an arrow or function expression. */
function namedFunctions(file: ts.SourceFile): Map<string, ts.FunctionLikeDeclaration> {
  const out = new Map<string, ts.FunctionLikeDeclaration>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) out.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer !== undefined && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          out.set(d.name.text, d.initializer);
        }
      }
    }
  }
  return out;
}

const enclosingFunction = (node: ts.Node): ts.FunctionLikeDeclaration | undefined => {
  let at: ts.Node | undefined = node.parent;
  while (at !== undefined && !ts.isFunctionLike(at)) at = at.parent;
  return at as ts.FunctionLikeDeclaration | undefined;
};

/** The name of the first `compose…()` call reachable while the file loads. */
function composedAtLoad(file: ts.SourceFile): string | undefined {
  const named = namedFunctions(file);
  const nameOf = new Map<ts.Node, string>([...named].map(([name, fn]) => [fn, name]));
  const calls: ts.CallExpression[] = [];
  const references: { name: string; at: ts.Node }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isIdentifier(node) && named.has(node.text) && !nameOf.has(node.parent) &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
        !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node)) {
      references.push({ name: node.text, at: node });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const memo = new Map<ts.Node, boolean>();
  // Does code in this context (undefined: module scope) run while the file loads?
  const loads = (fn: ts.FunctionLikeDeclaration | undefined): boolean => {
    if (fn === undefined) return true;
    const known = memo.get(fn);
    if (known !== undefined) return known;
    memo.set(fn, false); // a cycle adds nothing
    let result = false;
    let outer: ts.Node = fn;
    while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
    const call = outer.parent;
    if (call !== undefined && ts.isCallExpression(call)) {
      if (call.expression === outer) result = loads(enclosingFunction(call)); // called on the spot
      else if (call.arguments.includes(outer as ts.Expression) && calleeRoot(call.expression) === "describe") result = loads(enclosingFunction(call));
    }
    const name = nameOf.get(fn);
    if (!result && name !== undefined) {
      // Called, or passed to describe, from code that runs at load.
      result = references.some(({ name: ref, at }) => {
        if (ref !== name) return false;
        const parent = at.parent;
        if (!ts.isCallExpression(parent)) return false;
        const runsHere = parent.expression === at || (parent.arguments.includes(at as ts.Expression) && calleeRoot(parent.expression) === "describe");
        return runsHere && loads(enclosingFunction(parent));
      });
    }
    memo.set(fn, result);
    return result;
  };
  for (const call of calls) {
    const callee = call.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
    if (name !== undefined && COMPOSE.test(name) && loads(enclosingFunction(call))) return name;
  }
  return undefined;
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
  const composed = composedAtLoad(file);
  if (composed !== undefined) {
    return `${path} calls ${composed}() while the file is collected; compose the app only inside a test or a hook, ` +
      `after ${USE_APP_DATABASE}() has pointed DATABASE_URL at the app's own database`;
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
