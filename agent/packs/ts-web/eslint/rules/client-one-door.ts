import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-006 zone rule, src/**: the frontend has ONE door to the network.
//
// Runtime imports of `@trpc/client` and `@tanstack/*` are legal only under
// `src/ui/shared/api/`. Type-only imports are legal anywhere.
//
// This is `raw-framework-entry` again, one tier out. That rule gives the
// SERVICE one door because the error taxonomy is code in the shipped runtime;
// this one gives the CLIENT one door because the transport is: the URL, the
// batching, the headers, the single QueryClient whose cache is the app's whole
// shared read model. A second `createTRPCClient` is a second URL to get wrong.
// A second `new QueryClient` is worse — it splits the cache in half, and
// nothing fails: one half of the app simply stops seeing the other half's
// writes, intermittently, in a way that reads as a backend problem.
//
// It also buys the thing the reference set is actually for: components that can
// be tested. A component reaching `@tanstack/react-query` directly has a
// transport soldered into it; one reaching the door's `useServiceClient()` can
// be rendered under a provider holding a fake, and knows no difference.
//
// TYPE-ONLY IMPORTS ARE FREE EVERYWHERE, exactly as in raw-framework-entry: a
// `TRPCClientError` in a signature moves no bytes and opens no socket.
//
// The two packs' rules meet here and do not overlap: `@trpc/server` belongs to
// the ts-service pack's rule, `@trpc/client` to this one.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** The door, as a path fragment. Normalised for Windows separators, and matched
 *  as a suffix-bearing substring so an absolute path works as well as a
 *  project-relative one. */
const DOOR = "src/ui/shared/api/";

function isBehindTheDoor(filename: string): boolean {
  return filename.replace(/\\/g, "/").includes(DOOR);
}

function isTransportModule(source: string): boolean {
  return (
    source === "@trpc/client" ||
    source.startsWith("@trpc/client/") ||
    source === "@tanstack/react-query" ||
    source.startsWith("@tanstack/")
  );
}

export const clientOneDoor = createRule<[], "outsideDoor">({
  name: "client-one-door",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      outsideDoor:
        'a runtime import of "{{source}}" outside src/ui/shared/api/ — the frontend has one door to ' +
        "the network, because the transport lives there as code: one client, one URL, one QueryClient " +
        "whose cache is the app's shared read model (TN-26-006). Reach it through `useServiceClient()` " +
        "from shared/api/client.js and wrap queries in your own entity or feature hook; `import type` " +
        "is fine anywhere.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (isBehindTheDoor(context.filename)) return {};
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (!isTransportModule(node.source.value)) return;
        if (node.importKind === "type") return;
        // A value-position import whose every specifier is inline `type` is
        // type-only in effect; report only when some specifier is a value.
        // A bare `import "@tanstack/react-query"` has no specifiers at all and
        // IS a runtime import — it is a side effect, which is the one thing a
        // type cannot be.
        const hasValueSpecifier = node.specifiers.some(
          (s) => s.type !== TSESTree.AST_NODE_TYPES.ImportSpecifier || s.importKind !== "type",
        );
        if (!hasValueSpecifier && node.specifiers.length > 0) return;
        context.report({ node, messageId: "outsideDoor", data: { source: node.source.value } });
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration): void {
        if (!node.source || !isTransportModule(node.source.value)) return;
        if (node.exportKind === "type") return;
        context.report({ node, messageId: "outsideDoor", data: { source: node.source.value } });
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration): void {
        if (!node.source || !isTransportModule(node.source.value)) return;
        if (node.exportKind === "type") return;
        context.report({ node, messageId: "outsideDoor", data: { source: node.source.value } });
      },
    };
  },
});
