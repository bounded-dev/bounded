import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// One door to the server framework (TN-26-004, TN-26-012 §6). Procedures,
// routers and the one `initTRPC` instance of a context are GENERATED, from the
// feature contracts, into `contexts/<context>/src/adapters/in/trpc/`. Code a
// role writes may host that router — an app's server entry hands it to a
// transport adapter (`@trpc/server/adapters/fetch`) — but may not build
// procedures of its own: a second `initTRPC` is a second API surface no
// contract describes and no generated law checks.
//
// So a runtime import from `@trpc/server` is refused everywhere except:
//   * a transport adapter subpath, `@trpc/server/adapters/<name>`, which
//     serves a router and builds none;
//   * the generated in-adapter folder itself (write-denied to every role).
// Type-only imports are legal anywhere: a type cannot build a procedure.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

function isFrameworkModule(source: string): boolean {
  return source === "@trpc/server" || source.startsWith("@trpc/server/");
}

const isTransportAdapter = (source: string): boolean => /^@trpc\/server\/adapters\/[a-z0-9-]+$/.test(source);

function isExempt(filename: string): boolean {
  const path = filename.split("\\").join("/");
  return /(^|\/)src\/adapters\/in\/trpc\//.test(path);
}

export const rawFrameworkEntry = createRule<[], "rawEntry">({
  name: "raw-framework-entry",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      rawEntry:
        'a runtime import of "{{source}}" outside the generated tRPC adapter — procedures and routers are ' +
        "generated from the feature contracts (@exposedVia trpc) into adapters/in/trpc/, so a second initTRPC " +
        "is an API no contract describes. Host the context's router instead: import its factory from " +
        '"@<scope>/<context>/adapters/trpc" in the composition root and serve it with a transport adapter ' +
        '("@trpc/server/adapters/fetch"). `import type` is fine anywhere.',
    },
  },
  defaultOptions: [],
  create(context) {
    if (isExempt(context.filename)) return {};
    const check = (node: TSESTree.Node, source: string): void => {
      if (isFrameworkModule(source) && !isTransportAdapter(source)) {
        context.report({ node, messageId: "rawEntry", data: { source } });
      }
    };
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (node.importKind === "type") return;
        // A value-position import with only inline `type` specifiers is still
        // type-only in effect; report only when some specifier is a value.
        const hasValueSpecifier = node.specifiers.some(
          (s) => s.type !== TSESTree.AST_NODE_TYPES.ImportSpecifier || s.importKind !== "type",
        );
        if (!hasValueSpecifier && node.specifiers.length > 0) return;
        check(node, node.source.value);
      },
      ImportExpression(node: TSESTree.ImportExpression): void {
        if (node.source.type === TSESTree.AST_NODE_TYPES.Literal && typeof node.source.value === "string") {
          check(node, node.source.value);
        }
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration): void {
        if (!node.source || node.exportKind === "type") return;
        check(node, node.source.value);
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration): void {
        if (node.exportKind === "type") return;
        check(node, node.source.value);
      },
    };
  },
});
