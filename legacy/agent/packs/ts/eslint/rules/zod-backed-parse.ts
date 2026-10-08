import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// ADR 2026-031 zone rule, src/**: a value object's `static parse` is
// implemented over a zod schema — hand-rolled structural validation is the
// defect, not the schema library. Every builder hand-rolls differently;
// schemas compose (a command's schema is built from its field values'
// schemas), and the generated hostile-input laws interrogate a schema's
// judgment far better than they interrogate an ad-hoc `typeof` chain.
//
// WHAT COUNTS AS A VALUE OBJECT here: a class declaring a `__brand`
// property — `<Name>Impl`'s `declare readonly __brand` (ADR 2026-059). An
// entity's Impl has no static parse, so it is never checked. WHAT COUNTS AS ZOD-BACKED: the
// static parse's body references a binding imported from `zod` (usually
// `z`), or calls `.safeParse(…)` — the schema may live module-level and be
// shared, so the reference is the delegation. A skeleton's parse (throwing
// NotImplementedError) fails this rule only until the builder implements it,
// which is ordinary iteration, not friction.
//
// The rule checks the pairing exists; whether the schema is RIGHT is the
// generated law suite's half of the bargain (TN-26-004).

const createRule = ESLintUtils.RuleCreator.withoutDocs;

function isBrandProperty(member: TSESTree.ClassElement): boolean {
  return (
    member.type === TSESTree.AST_NODE_TYPES.PropertyDefinition &&
    member.key.type === TSESTree.AST_NODE_TYPES.Identifier &&
    member.key.name === "__brand"
  );
}

function isStaticParse(member: TSESTree.ClassElement): member is TSESTree.MethodDefinition {
  return (
    member.type === TSESTree.AST_NODE_TYPES.MethodDefinition &&
    member.static &&
    member.key.type === TSESTree.AST_NODE_TYPES.Identifier &&
    member.key.name === "parse"
  );
}

/** Does any node in this subtree reference zod (an imported binding) or call
 *  `.safeParse`? A hand walk, not scope analysis: deterministic and total. */
function delegatesToZod(node: TSESTree.Node, zodLocals: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (n: TSESTree.Node | null | undefined): void => {
    if (found || n === null || n === undefined || typeof n !== "object") return;
    if ((n as { type?: unknown }).type === undefined) return;
    if (
      n.type === TSESTree.AST_NODE_TYPES.Identifier &&
      zodLocals.has((n as TSESTree.Identifier).name)
    ) {
      found = true;
      return;
    }
    if (
      n.type === TSESTree.AST_NODE_TYPES.MemberExpression &&
      n.property.type === TSESTree.AST_NODE_TYPES.Identifier &&
      n.property.name === "safeParse"
    ) {
      found = true;
      return;
    }
    for (const key of Object.keys(n)) {
      if (key === "parent") continue;
      const value = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) value.forEach((v) => visit(v as TSESTree.Node));
      else if (value !== null && typeof value === "object") visit(value as TSESTree.Node);
    }
  };
  visit(node);
  return found;
}

export const zodBackedParse = createRule<[], "handRolled">({
  name: "zod-backed-parse",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      handRolled:
        "{{className}}.parse validates by hand — a value object's parse is implemented over a zod schema " +
        "(ADR 2026-031): declare the schema module-level (const schema = z.…), delegate with schema.safeParse(raw), " +
        "and compose field values' schemas rather than re-checking them. Hand-rolled typeof-chains drift apart " +
        "across builders and evade the generated hostile-input laws' leverage.",
    },
  },
  defaultOptions: [],
  create(context) {
    const zodLocals = new Set<string>();
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (node.source.value !== "zod" && !node.source.value.startsWith("zod/")) return;
        for (const spec of node.specifiers) zodLocals.add(spec.local.name);
      },
      ClassDeclaration(node: TSESTree.ClassDeclaration): void {
        if (!node.body.body.some(isBrandProperty)) return;
        const parse = node.body.body.find(isStaticParse);
        if (parse === undefined || parse.value.body === null || parse.value.body === undefined) return;
        if (delegatesToZod(parse.value.body, zodLocals)) return;
        context.report({
          node: parse,
          messageId: "handRolled",
          data: { className: node.id?.name ?? "the value object" },
        });
      },
    };
  },
});
