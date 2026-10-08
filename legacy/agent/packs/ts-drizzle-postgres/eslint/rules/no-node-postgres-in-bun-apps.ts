import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// A Bun app's production code never reaches for node-postgres (ADR 2026-072).
//
// Every app of a persisting project pins `pg` (and Testcontainers) as dev
// dependencies, because its generated smoke-test database support migrates
// through node-postgres. That trade makes `pg` resolvable from a Bun app's
// own source too, where the generated composition root already connects with
// `drizzle-orm/bun-sql`: a second driver there would ship a dev dependency
// to production and split the app's connections. So the builder's lint
// refuses it.
//
// SCOPE, read from the tree: a file under `apps/<app>/src/` whose app
// manifest's `build` script does NOT bundle with `--target node` (a Bun app:
// web, MCP). Node apps (Lambda, the Electron main process) use node-postgres
// as their driver and are out of scope; test-side files are not the
// builder's and never reach this lint.
//
// Refused: a value import, or a dynamic import, of `pg`, `pg/*` or
// `drizzle-orm/node-postgres*`. Type-only imports are erased and stay legal.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

const isNodePostgres = (source: string): boolean =>
  source === "pg" || source.startsWith("pg/") || source === "drizzle-orm/node-postgres" || source.startsWith("drizzle-orm/node-postgres/");

/** The app directory of a file under `apps/<app>/src/`, as a prefix of `filename`. */
function appDirOf(filename: string): string | undefined {
  const match = /^(.*?(?:^|\/)apps\/[^/]+)\/src\//.exec(filename.split("\\").join("/"));
  return match?.[1];
}

/** Does this app run on Bun: its manifest does not build for Node? */
function runsOnBun(appDir: string): boolean {
  const manifest = join(appDir, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, unknown> };
    const build = parsed.scripts?.["build"];
    return !(typeof build === "string" && /--target[ =]node\b/.test(build));
  } catch {
    return false;
  }
}

export const noNodePostgresInBunApps = createRule<[], "nodePostgres">({
  name: "no-node-postgres-in-bun-apps",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      nodePostgres:
        'a runtime import of "{{source}}" in an app that runs on Bun: its composition root connects with ' +
        "drizzle-orm/bun-sql, and node-postgres is pinned only for the generated test-database support. " +
        "Reach the database through what the composition root constructs; `import type` is fine.",
    },
  },
  defaultOptions: [],
  create(context) {
    const appDir = appDirOf(context.filename);
    if (appDir === undefined || !runsOnBun(appDir)) return {};
    const check = (node: TSESTree.Node, source: string): void => {
      if (isNodePostgres(source)) context.report({ node, messageId: "nodePostgres", data: { source } });
    };
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (node.importKind === "type") return;
        const hasValueSpecifier = node.specifiers.some(
          (s) => s.type !== TSESTree.AST_NODE_TYPES.ImportSpecifier || s.importKind !== "type",
        );
        if (!hasValueSpecifier && node.specifiers.length > 0) return;
        check(node, node.source.value);
      },
      ImportExpression(node: TSESTree.ImportExpression): void {
        if (node.source.type === TSESTree.AST_NODE_TYPES.Literal && typeof node.source.value === "string") check(node, node.source.value);
      },
    };
  },
});
