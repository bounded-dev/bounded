import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-004 zone rule, src/**: the shipped service runtime is the ONLY module
// that may touch the RPC framework's raw entry points at runtime. The error
// taxonomy (parse failure → BAD_REQUEST, catch-all → INTERNAL, the named
// throwers for the rest) lives inside `service-runtime.ts` as code; a second
// `initTRPC` elsewhere is a second place the taxonomy can be got wrong, which
// is precisely what shipping ONE implementation exists to prevent.
//
// Type-only imports stay legal everywhere (`import type { TRPCError }` for a
// signature harms nothing — types cannot re-map an error code), and the
// runtime file itself is exempt by name: it is generated, marker-carrying,
// and byte-compared against the pack's canonical copy on every scaffold, so
// an edit to it does not survive a design_gate anyway.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

// THE SERVER DOOR, and only the server door (TN-26-006 B1). This used to read
// `source.startsWith("@trpc/")`, which swept in `@trpc/client` — and the
// frontend's one door imports `@trpc/client` by design, so the ts-service pack's
// server-side rule was refusing the ts-web pack's correct code.
//
// The narrowing is not a relaxation, it is the rule saying what it always
// meant. Every word of its reasoning is about the SERVER: `initTRPC`, the error
// taxonomy (parse failure → BAD_REQUEST, the named throwers), the shipped
// `service-runtime.ts` that holds them as code. `@trpc/client` has no taxonomy
// to re-map — it is a transport — and the frontend's own one-door rule
// (`client-one-door`, contributed by ts-web) is what confines it to
// `src/ui/shared/api/`. Two doors, two packs, one rule each; the service pack does
// not learn that a frontend exists.
function isFrameworkModule(source: string): boolean {
  return source === "@trpc/server" || source.startsWith("@trpc/server/");
}

export const rawFrameworkEntry = createRule<[], "rawEntry">({
  name: "raw-framework-entry",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      rawEntry:
        'a runtime import of "{{source}}" outside service-runtime.ts — the shipped runtime is the one place ' +
        "the framework's raw entry points may be touched, because the error taxonomy lives there as code " +
        "(TN-26-004). Build procedures through createService/command/query from ./service-runtime.js; " +
        "`import type` is fine anywhere.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (context.filename.endsWith("service-runtime.ts")) return {};
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (!isFrameworkModule(node.source.value)) return;
        if (node.importKind === "type") return;
        // A value-position import with only inline `type` specifiers is still
        // type-only in effect; report only when some specifier is a value.
        const hasValueSpecifier = node.specifiers.some(
          (s) =>
            s.type !== TSESTree.AST_NODE_TYPES.ImportSpecifier || s.importKind !== "type",
        );
        if (!hasValueSpecifier && node.specifiers.length > 0) return;
        context.report({ node, messageId: "rawEntry", data: { source: node.source.value } });
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration): void {
        if (!node.source || !isFrameworkModule(node.source.value)) return;
        if (node.exportKind === "type") return;
        context.report({ node, messageId: "rawEntry", data: { source: node.source.value } });
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration): void {
        if (!node.source || !isFrameworkModule(node.source.value)) return;
        if (node.exportKind === "type") return;
        context.report({ node, messageId: "rawEntry", data: { source: node.source.value } });
      },
    };
  },
});
