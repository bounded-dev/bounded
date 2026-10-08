import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// A tRPC client is typed by the router type the context's generated adapter
// RE-EXPORTS (ADR LEG-2026-030, TN-26-012 §6), and by nothing else.
//
// The generated `adapters/in/trpc/index.ts` of every context ends in
// `export { create<Context>Router, type <Context>Router } from "./router.ts"`,
// and the context's package exports that barrel as `./adapters/trpc`. That
// re-exported type is the whole API, inferred from the generated procedures,
// so a client typed by it is checked against every route the contracts
// declare. Dogfood Runs 22 and 23 showed the two ways the typed client dies
// silently: an erased type (`no-erased-router`'s case), and no type at all.
// This rule is the second: a client factory called with no router type, or
// with a type that is not that re-export — a local alias, a hand-written
// object type, `typeof` a value — is refused.
//
// THE WHOLE SHAPE IT DEMANDS (the worked example's apps/web/src/client/main.tsx):
//
//   import type { ProjectManagementRouter } from "@example/project-management/adapters/trpc";
//   const api = createTRPCClient<ProjectManagementRouter>({ links: [httpBatchLink({ url: "/trpc" })] });
//
// The import must be type-only: a client that imports the barrel as a value
// would bundle the server's procedures into the browser.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** Client factories that take the router type as their one type argument. */
const CLIENT_FACTORIES = new Set([
  "createTRPCClient",
  "createTRPCProxyClient",
  "createTRPCReact",
  "createTRPCContext",
  "createTRPCOptionsProxy",
]);

const isClientModule = (source: string): boolean => source.startsWith("@trpc/");
const isRouterBarrel = (source: string): boolean => /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\/adapters\/trpc$/.test(source);

export const routerTypeReexported = createRule<[], "missing" | "notReexported">({
  name: "router-type-reexported",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      missing:
        "{{factory}} is called without a router type, so every call through it is untyped (dogfood r23: the typed " +
        "client died with nothing to bounce on). Pass the router type the context's generated tRPC adapter " +
        're-exports: import type { ProjectManagementRouter } from "@<scope>/<context>/adapters/trpc"; ' +
        "{{factory}}<ProjectManagementRouter>(…).",
      notReexported:
        "{{factory}}<{{type}}> is not typed by a router type the generated tRPC adapter re-exports. The router's " +
        "type is inferred from the generated procedures and re-exported by the context's ./adapters/trpc barrel; " +
        "any other type can drift from the real API. Import it type-only: " +
        'import type { ProjectManagementRouter } from "@<scope>/<context>/adapters/trpc";',
    },
  },
  defaultOptions: [],
  create(context) {
    /** Local names of the client factories imported from a @trpc module. */
    const factories = new Map<string, string>();
    /** Local names imported type-only from a context's tRPC barrel. */
    const routerTypes = new Set<string>();

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        const source = node.source.value;
        for (const spec of node.specifiers) {
          if (spec.type !== TSESTree.AST_NODE_TYPES.ImportSpecifier || spec.imported.type !== TSESTree.AST_NODE_TYPES.Identifier) continue;
          if (isClientModule(source) && CLIENT_FACTORIES.has(spec.imported.name)) factories.set(spec.local.name, spec.imported.name);
          if (isRouterBarrel(source) && (node.importKind === "type" || spec.importKind === "type")) routerTypes.add(spec.local.name);
        }
      },
      CallExpression(node: TSESTree.CallExpression): void {
        if (node.callee.type !== TSESTree.AST_NODE_TYPES.Identifier) return;
        const factory = factories.get(node.callee.name);
        if (factory === undefined) return;
        const args = node.typeArguments?.params ?? [];
        if (args.length === 0) {
          context.report({ node, messageId: "missing", data: { factory } });
          return;
        }
        const type = args[0]!;
        const ok = args.length === 1 && type.type === TSESTree.AST_NODE_TYPES.TSTypeReference &&
          type.typeName.type === TSESTree.AST_NODE_TYPES.Identifier && type.typeArguments === undefined &&
          routerTypes.has(type.typeName.name);
        if (!ok) {
          context.report({ node: type, messageId: "notReexported", data: { factory, type: context.sourceCode.getText(type) } });
        }
      },
    };
  },
});
