import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-001 architect zone rule: branded TYPE ALIASES are banned in contracts —
// the interface + factory pair of ADR LEG-2026-059 (whose implementation class has
// a private constructor) is the only value-object form the system can keep
// honest. (Written against the retired `declare class` form; the reasoning
// below is unchanged, only the prescribed shape moved.)
//
// Run 9 is why. Under escape-hatch pressure (`as` is banned in src/), the
// architect rewrote every value object as
//
//   export type Currency = string & { readonly __brand?: 'Currency' };
//
// and every gate passed. The OPTIONAL brand makes any bare string assignable —
// the brand is a costume, nominality is zero — and because no exported class
// existed, value-object-shape stayed silent, no law suite was generated, and
// the boundaries obligation never fired. The whole coverage machinery was
// disarmed by a question mark.
//
// Banning only the optional form would not fix it, because the REQUIRED form
// is incoherent under the same regime: `raw as Currency` is the only way to
// construct a required-brand alias, and the src lint bans `as` with no
// exemption list. A contract demanding what the builder cannot legally write
// is a deadlock by design. The class has a real constructor; it is the only
// value-object shape that needs no escape hatch, which is precisely why it is
// canonical (see ts-contract-authoring, "The canonical shape is a nominal
// class").
//
// TRIGGER (deterministic on purpose): an exported type alias whose type is an
// intersection containing BOTH a primitive keyword (string | number | bigint)
// AND an object-literal member — the branded-alias pattern, optional or not.
// Ordinary object-type aliases, unions, and interfaces are untouched.
// no-naked-primitives still deliberately never enters intersections; this rule
// is why it no longer needs to.

export const noBrandedAliases = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: "problem",
    schema: [],
    messages: {
      brandedAlias:
        "'{{name}}' is a branded type alias — a primitive intersected with a brand object. " +
        "{{teeth}} Write the value object as the contract-owns-the-name pair instead (ADR LEG-2026-059, ts-contract-authoring), " +
        "in its own '<concept>.contract.ts':\n" +
        "  import type { Result } from \"../shared/result.ts\";\n" +
        "  export interface {{name}} {\n" +
        "    readonly __brand: \"{{name}}\";\n" +
        "    readonly value: {{base}};\n" +
        "    equals(other: {{name}}): boolean;\n" +
        "    toJSON(): {{base}};\n" +
        "  }\n" +
        "  export interface {{name}}Factory {\n" +
        "    parse(raw: unknown): Result<{{name}}>;\n" +
        "  }\n" +
        "The emitter generates '{{name}}Impl', whose private constructor is the only way to build one.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      TSTypeAliasDeclaration(node: TSESTree.TSTypeAliasDeclaration): void {
        const exported =
          node.parent.type === "ExportNamedDeclaration" || node.parent.type === "TSModuleBlock";
        if (!exported) return;
        if (node.typeAnnotation.type !== "TSIntersectionType") return;
        let base: string | undefined;
        let hasObjectMember = false;
        let optionalBrand = false;
        for (const part of node.typeAnnotation.types) {
          if (part.type === "TSStringKeyword") base = "string";
          else if (part.type === "TSNumberKeyword") base = "number";
          else if (part.type === "TSBigIntKeyword") base = "bigint";
          else if (part.type === "TSTypeReference" && part.typeName.type === "Identifier") {
            // `DateString & {...}` — an alias branded on top of another alias.
            // Treat the reference as the base; the pattern is the same.
            base = base ?? part.typeName.name;
          } else if (part.type === "TSTypeLiteral" && part.members.length > 0) {
            hasObjectMember = true;
            for (const m of part.members) {
              if (m.type === "TSPropertySignature" && m.optional) optionalBrand = true;
            }
          }
        }
        if (base === undefined || !hasObjectMember) return;
        context.report({
          node: node.id,
          messageId: "brandedAlias",
          data: {
            name: node.id.name,
            base,
            teeth: optionalBrand
              ? "The brand is OPTIONAL, so every bare " + base + " is assignable and it enforces nothing at all."
              : "It can only be constructed with a cast, and casts are banned in implementation code with no exemption list — the contract would demand what the builder cannot legally write.",
          },
        });
      },
    };
  },
});
