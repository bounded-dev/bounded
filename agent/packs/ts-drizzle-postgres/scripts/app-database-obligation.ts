// The app-database obligation (issue #52, ADR 2026-072), contributed to the ts
// pack's `testObligations` socket at green. In a project that persists
// through Drizzle, every app smoke test (ts-hexagonal's
// `composition-root.test.ts`) must start its own migrated Postgres through the
// generated support before it composes the app:
//
//   · a top-level expression statement `useAppDatabase()`, with
//     `useAppDatabase` imported (not type-only) from
//     `./app-test-database.test-support.ts`. A call in dead code, in a function
//     nobody calls, behind a short-circuit or inside a test is not one;
//   · no `compose…()` call while the file is collected: at module scope, in
//     a `describe` callback, or in a function called on the spot. Inside a
//     test, a hook, or a function they call, it runs after the support has
//     set DATABASE_URL.
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

/** A top-level `name()` expression statement. */
function calledAtTopLevel(file: ts.SourceFile, name: string): boolean {
  return file.statements.some((statement) => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
    ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === name);
}

const unwrap = (node: ts.Node): ts.Node => {
  let at = node;
  while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
  return at;
};

/** Does this function run while the file is collected: a `describe` callback, or a function called on the spot? */
function runsAtCollection(fn: ts.FunctionLikeDeclaration): boolean {
  const outer = unwrap(fn);
  const call = outer.parent;
  if (call === undefined || !ts.isCallExpression(call)) return false;
  if (call.expression === outer) return true;
  if (!call.arguments.includes(outer as ts.Expression)) return false;
  const callee = call.expression;
  const head = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
  return ts.isIdentifier(head) && head.text === "describe";
}

/** The name of the first `compose…()` call that runs while the file is collected. */
function composedAtCollection(file: ts.SourceFile): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name !== undefined && COMPOSE.test(name)) {
        let at: ts.Node | undefined = node.parent;
        while (at !== undefined && !ts.isFunctionLike(at)) at = at.parent;
        if (at === undefined || runsAtCollection(at as ts.FunctionLikeDeclaration)) found = name;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
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
  const composed = composedAtCollection(file);
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
