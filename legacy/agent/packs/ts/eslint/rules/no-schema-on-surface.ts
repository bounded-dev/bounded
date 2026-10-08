import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-004 / ADR LEG-2026-031 architect zone rule: zod is the parsing ENGINE
// inside a value object, never a public identity — so nothing from zod may
// appear in a contract at all. The contract's whole validation surface is
// the factory's `parse(raw: unknown): Result<T>` (ADR LEG-2026-059); that a zod
// schema sits behind it, in `<Name>Impl`, is invisible to every consumer.
//
// Why total (any zod import, type or value, any specifier): a `ZodType` in a
// signature, a re-exported schema, a `z.infer<…>` alias — each one makes the
// schema a SECOND public identity for the same value, which is exactly the
// dual-identity defect ADR LEG-2026-023 exists to prevent, one layer out. And a
// rule that had to distinguish "harmless" zod types from harmful ones would
// need judgment a purity lint does not have. The implementation module may
// import zod freely; the contract may not mention it.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

function isZodModule(source: string): boolean {
  return source === "zod" || source.startsWith("zod/");
}

export const noSchemaOnSurface = createRule<[], "zodImport" | "zodReexport">({
  name: "no-schema-on-surface",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      zodImport:
        'a contract may not import from "{{source}}" — the schema is the value object\'s internal engine (ADR ' +
        "LEG-2026-031), and any zod name on a contract surface makes it a second public identity for the same value " +
        "(ADR LEG-2026-023). Declare 'parse(raw: unknown): Result<T>' on the '<Name>Factory' interface and keep the " +
        "schema in the implementation file, beside '<Name>Impl'.",
      zodReexport:
        're-exporting from "{{source}}" puts the schema engine on this contract\'s surface — the schema is the ' +
        "value object's internal engine (ADR LEG-2026-031), never a public identity (ADR LEG-2026-023). Keep it in the " +
        "implementation module.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (!isZodModule(node.source.value)) return;
        context.report({ node, messageId: "zodImport", data: { source: node.source.value } });
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration): void {
        if (!node.source || !isZodModule(node.source.value)) return;
        context.report({ node, messageId: "zodReexport", data: { source: node.source.value } });
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration): void {
        if (!isZodModule(node.source.value)) return;
        context.report({ node, messageId: "zodReexport", data: { source: node.source.value } });
      },
    };
  },
});
