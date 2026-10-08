import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// Code bundled for Node must not use Bun's runtime APIs (ADR LEG-2026-062).
//
// The project is a Bun monorepo: Bun installs, tests, serves and bundles. But
// a Lambda app is bundled with `bun build --target node` because the Lambda
// runtime is Node, where `Bun` does not exist. Nothing fails until the
// function is invoked in production: `bun test` runs the code on Bun, where
// `Bun.file` works, and the bundler happily inlines a reference to a global
// that will be `undefined` at runtime. So the gate is here, at lint.
//
// SCOPE, read from the tree: a file under `apps/<app>/src/` whose app
// manifest's `build` script bundles with `--target node`. That is every
// Lambda app (the ts-lambda template), and also any other app built for Node
// (an Electron main process), which has the same constraint. Everything else
// runs on Bun and is out of scope.
//
// Refused: a value import from `bun` or a `bun:*` module; a value reference
// to the `Bun` global; and the Bun-only `import.meta` members (`main`, `dir`,
// `file`, `path`, `env`). Type-only imports are erased and stay legal.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

const BUN_META = new Set(["main", "dir", "file", "path", "env"]);
const isBunModule = (source: string): boolean => source === "bun" || source.startsWith("bun:");

/** The app directory of a file under `apps/<app>/src/`, as a prefix of `filename`. */
export function appDirOf(filename: string): string | undefined {
  const path = filename.split("\\").join("/");
  const match = /^(.*?(?:^|\/)apps\/[^/]+)\/src\//.exec(path);
  return match?.[1];
}

/** Is this app bundled for Node? Read from its manifest's `build` script. */
export function buildsForNode(appDir: string): boolean {
  const manifest = join(appDir, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, unknown> };
    const build = parsed.scripts?.["build"];
    return typeof build === "string" && /--target[ =]node\b/.test(build);
  } catch {
    return false;
  }
}

export const noBunApi = createRule<[], "bunModule" | "bunGlobal" | "bunMeta">({
  name: "no-bun-api",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      bunModule:
        'a runtime import of "{{source}}" in an app bundled with `bun build --target node` — it runs on Node (the ' +
        "Lambda runtime), where Bun's modules do not exist. Use the Node or web-standard equivalent " +
        "(node:fs, fetch, crypto.randomUUID); `import type` is fine.",
      bunGlobal:
        "`Bun` in an app bundled with `bun build --target node` — it runs on Node (the Lambda runtime), where the " +
        "`Bun` global is undefined and this line throws only when invoked. Use the Node or web-standard equivalent.",
      bunMeta:
        "`import.meta.{{member}}` is Bun-only, and this app is bundled with `bun build --target node` to run on " +
        "Node (the Lambda runtime). Use import.meta.url, import.meta.dirname or import.meta.filename.",
    },
  },
  defaultOptions: [],
  create(context) {
    const appDir = appDirOf(context.filename);
    if (appDir === undefined || !buildsForNode(appDir)) return {};
    const moduleSource = (node: TSESTree.Node, source: string): void => {
      if (isBunModule(source)) context.report({ node, messageId: "bunModule", data: { source } });
    };
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (node.importKind === "type") return;
        const hasValueSpecifier = node.specifiers.some(
          (s) => s.type !== TSESTree.AST_NODE_TYPES.ImportSpecifier || s.importKind !== "type",
        );
        if (!hasValueSpecifier && node.specifiers.length > 0) return;
        moduleSource(node, node.source.value);
      },
      ImportExpression(node: TSESTree.ImportExpression): void {
        if (node.source.type === TSESTree.AST_NODE_TYPES.Literal && typeof node.source.value === "string") {
          moduleSource(node, node.source.value);
        }
      },
      MemberExpression(node: TSESTree.MemberExpression): void {
        if (node.object.type !== TSESTree.AST_NODE_TYPES.MetaProperty || node.object.meta.name !== "import") return;
        if (node.property.type === TSESTree.AST_NODE_TYPES.Identifier && BUN_META.has(node.property.name)) {
          context.report({ node, messageId: "bunMeta", data: { member: node.property.name } });
        }
      },
      "Program:exit"(program: TSESTree.Program): void {
        const scope = context.sourceCode.getScope(program);
        for (const reference of scope.through) {
          if (reference.identifier.name === "Bun" && reference.isValueReference) {
            context.report({ node: reference.identifier, messageId: "bunGlobal" });
          }
        }
      },
    };
  },
});
