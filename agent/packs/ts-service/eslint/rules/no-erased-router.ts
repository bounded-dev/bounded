import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-004 / ADR 2026-030 architect zone rule: a contract may not put a
// type-ERASED framework type on its public surface. The reproduce case is
// dogfood Run 22: the architect could not express tRPC's inferred router type
// in a declaration-only contract, declared `export type ServiceRouter =
// AnyRouter`, and shipped it — which silently threw away the typed client the
// whole service exists to provide (`inferRouterInputs<AnyRouter>` yields
// nothing usable). The reviewer flagged it; review is advisory; no gate
// objected. This rule is the gate.
//
// The correct form is the ADR 2026-026 route: the ROUTER TYPE IS INFERRED,
// so the contract re-exports it from the implementation module, where the
// inference lives —
//
//   import type { serviceRouter } from "./api.js";
//   export type ServiceRouter = typeof serviceRouter;
//
// A type-only import cycle (impl imports contract, contract imports impl's
// type) is legal TypeScript and erases at compile time.
//
// SCOPE. Two shapes are refused, both deterministic without type info:
//   * importing an `Any*`-named type from a `@trpc/…` module — the erased
//     types are a family (`AnyRouter`, `AnyProcedure`, `AnyTRPCRouter`, …)
//     and every member matches /^Any[A-Z]/;
//   * a type REFERENCE whose name is one of the known erased-router names,
//     wherever it came from — a hand-rolled `type AnyRouter = …` alias is the
//     same erasure wearing a local name.
// A non-contract file is never touched: this is a purity rule about the
// declared surface, and the runtime wrapper (which legitimately handles
// generic routers) lives in the implementation zone.

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
  return source === "@trpc/server" || source.startsWith("@trpc/");
}

export const noErasedRouter = createRule<[], "erasedImport" | "erasedReference">({
  name: "no-erased-router",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      erasedImport:
        "'{{what}}' is a type-erased framework type — declaring the service surface with it throws away the " +
        "typed client the service exists to provide (dogfood r22: `ServiceRouter = AnyRouter` shipped a client " +
        "whose inputs are `unknown`). The router's type is INFERRED, so re-export it from the implementation " +
        'module instead (ADR 2026-026): import type { serviceRouter } from "./api.js"; export type ServiceRouter ' +
        "= typeof serviceRouter;",
      erasedReference:
        "'{{what}}' erases the router's type on this contract's surface — a client typed against it gets " +
        "`unknown` inputs (dogfood r22). Re-export the inferred type from the implementation module instead " +
        '(ADR 2026-026): import type { serviceRouter } from "./api.js"; export type ServiceRouter = typeof ' +
        "serviceRouter;",
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
            context.report({
              node: spec,
              messageId: "erasedImport",
              data: { what: spec.imported.name },
            });
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
