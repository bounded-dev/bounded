// The delivery obligation of a project that composed ts-web (ADR 2026-036),
// scoped to the web apps the design declares (TN `workspaces:` maps, the same
// reader the shipped check:build uses). With none declared it passes and says
// it checked nothing. For each declared web app, read-only and static:
//
//   * the whole door exists: server entry, composition root, client page and
//     client entry;
//   * the client bundles: the page's script and every relative import
//     reachable from the client entry resolve to a file (dogfood Run 29
//     shipped a main.tsx importing an app.tsx nobody wrote);
//   * the client reaches the service: main.tsx creates a tRPC client typed by
//     a router type re-exported from a context's ./adapters/trpc, and uses it.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import type { DeliverCheckResult } from "../../ts/pack.ts";
import { declaredWebApps } from "./web-build-check.ts";

const REQUIRED = ["src/client/index.html", "src/client/main.tsx", "src/server/main.ts", "src/server/composition-root.ts"];
const CODE = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const CLIENT_FACTORIES = new Set(["createTRPCClient", "createTRPCProxyClient"]);

/** The file a relative specifier resolves to, or undefined. */
function resolveRelative(from: string, specifier: string): string | undefined {
  const base = join(dirname(from), specifier);
  const swapped = /\.[cm]?jsx?$/.test(base) ? [base.replace(/\.[cm]?jsx?$/, ".ts"), base.replace(/\.[cm]?jsx?$/, ".tsx")] : [];
  const candidates = [base, ...swapped, ...CODE.map((ext) => base + ext), ...CODE.map((ext) => join(base, `index${ext}`))];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

function specifiersOf(source: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Relative imports reachable from `entry` that resolve to nothing. */
export function unresolvedImports(cwd: string, entry: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!CODE.some((ext) => file.endsWith(ext))) continue;
    for (const specifier of specifiersOf(parse(file))) {
      if (!specifier.startsWith(".")) continue;
      const target = resolveRelative(file, specifier);
      if (target === undefined) problems.push(`${relative(cwd, file)}: "${specifier}" does not resolve`);
      else queue.push(target);
    }
  }
  return problems;
}

/** What is wrong with the client entry's typed client, if anything. */
export function typedClientProblems(cwd: string, main: string): string[] {
  const source = parse(main);
  const where = relative(cwd, main);
  const factories = new Set<string>();
  const routerTypes = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (from === "@trpc/client" && CLIENT_FACTORIES.has(imported)) factories.add(element.name.text);
      if (/\/adapters\/trpc$/.test(from) && (statement.importClause?.isTypeOnly || element.isTypeOnly)) routerTypes.add(element.name.text);
    }
  }
  const clients: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined &&
        ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
        factories.has(node.initializer.expression.text)) {
      const type = node.initializer.typeArguments?.[0];
      if (type !== undefined && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && routerTypes.has(type.typeName.text)) {
        clients.push(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (clients.length === 0) {
    return [`${where}: creates no tRPC client typed by a router type imported type-only from a context's ./adapters/trpc`];
  }
  const uses = new Map(clients.map((name) => [name, 0]));
  const count = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && uses.has(node.text) && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) {
      uses.set(node.text, uses.get(node.text)! + 1);
    }
    ts.forEachChild(node, count);
  };
  count(source);
  return [...uses].filter(([, n]) => n === 0).map(([name]) => `${where}: the typed client '${name}' is never used`);
}

/** The page's module scripts that do not resolve. */
function unresolvedPageScripts(cwd: string, page: string): string[] {
  const html = readFileSync(page, "utf8");
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!)
    .filter((src) => src.startsWith(".") && resolveRelative(page, src) === undefined)
    .map((src) => `${relative(cwd, page)}: script "${src}" does not resolve`);
}

export function runWebObligation(cwd: string): DeliverCheckResult {
  let apps: string[];
  try {
    apps = declaredWebApps(cwd);
  } catch (error) {
    return { verdict: "block", summary: `ts-web: ${(error as Error).message}` };
  }
  if (apps.length === 0) return { verdict: "pass", summary: "ts-web: no web app is declared (TN workspaces) — nothing to check" };
  const detail: string[] = [];
  for (const app of apps) {
    const missing = REQUIRED.filter((file) => !existsSync(join(cwd, app, file)));
    detail.push(...missing.map((file) => `${app}/${file} is missing`));
    const page = join(cwd, app, "src/client/index.html");
    const main = join(cwd, app, "src/client/main.tsx");
    if (existsSync(page)) detail.push(...unresolvedPageScripts(cwd, page));
    if (existsSync(main)) detail.push(...unresolvedImports(cwd, main), ...typedClientProblems(cwd, main));
  }
  if (detail.length > 0) return { verdict: "block", summary: "ts-web: a declared web app cannot serve its client", detail };
  return { verdict: "pass", summary: `ts-web: ${apps.join(", ")} serve a bundling client typed by the hosted router` };
}
