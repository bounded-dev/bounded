import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// A type-ERASED tRPC type is never the right type (ADR 2026-030, TN-26-012).
// The reproduce case is dogfood Run 22: `ServiceRouter = AnyRouter` shipped a
// typed client whose inputs are `unknown`, flagged by the reviewer, refused by
// nothing. In the hexagonal layout the router's real type is generated with
// the in adapter — `export type <Context>Router` in
// `adapters/in/trpc/router.ts`, re-exported by the context's
// `./adapters/trpc` barrel — so there is never a reason to reach for an
// erased one, in a contract (the architect's zone) or in an app (the
// builder's: a client, a seed script, a composition root).
//
// Two shapes are refused, both deterministic without type information:
//   * importing an `Any*`-named type from a `@trpc/…` module — the erased
//     types are a family (`AnyRouter`, `AnyProcedure`, `AnyTRPCRouter`, …)
//     and every member matches /^Any[A-Z]/;
//   * a type REFERENCE whose name is one of the known erased names, wherever
//     it came from — a hand-rolled `type AnyRouter = …` alias is the same
//     erasure wearing a local name.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** The erased tRPC surface types worth naming individually: a reference to one
 *  of these IS the defect even if it was laundered through a local alias. */
const ERASED_NAMES = new Set([
  "AnyRouter",
  "AnyTRPCRouter",
  "AnyProcedure",
  "AnyQueryProcedure",
  "AnyMutationProcedure",
  "AnySubscriptionProcedure",
]);

function isTrpcModule(source: string): boolean {
  return source.startsWith("@trpc/");
}

const REMEDY =
  "Use the router type the context's generated tRPC adapter exports: " +
  'import type { ProjectManagementRouter } from "@<scope>/<context>/adapters/trpc";';

export const noErasedRouter = createRule<[], "erasedImport" | "erasedReference">({
  name: "no-erased-router",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      erasedImport:
        "'{{what}}' is a type-erased tRPC type — typing anything with it throws away the typed client the in " +
        `adapter exists to provide (dogfood r22: \`ServiceRouter = AnyRouter\` shipped inputs of \`unknown\`). ${REMEDY}`,
      erasedReference:
        "'{{what}}' erases the router's type — a client typed against it gets `unknown` inputs (dogfood r22). " +
        REMEDY,
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (!isTrpcModule(node.source.value)) return;
        for (const spec of node.specifiers) {
          if (
            spec.type === TSESTree.AST_NODE_TYPES.ImportSpecifier &&
            spec.imported.type === TSESTree.AST_NODE_TYPES.Identifier &&
            /^Any[A-Z]/.test(spec.imported.name)
          ) {
            context.report({ node: spec, messageId: "erasedImport", data: { what: spec.imported.name } });
          }
        }
      },
      TSTypeReference(node: TSESTree.TSTypeReference): void {
        const name =
          node.typeName.type === TSESTree.AST_NODE_TYPES.Identifier
            ? node.typeName.name
            : node.typeName.type === TSESTree.AST_NODE_TYPES.TSQualifiedName &&
                node.typeName.right.type === TSESTree.AST_NODE_TYPES.Identifier
              ? node.typeName.right.name
              : undefined;
        if (name !== undefined && ERASED_NAMES.has(name)) {
          context.report({ node, messageId: "erasedReference", data: { what: name } });
        }
      },
    };
  },
});
