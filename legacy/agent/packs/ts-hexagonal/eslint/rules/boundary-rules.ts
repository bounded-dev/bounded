// The four import-boundary rules. Each reports one family of the problems
// `boundaryProblems` finds (eslint/hexagonal.ts), the same families the shipped
// architecture.test.ts fails on, so a builder hears about a crossed boundary
// on the file it just wrote instead of at the next test run.

import { ESLintUtils } from "@typescript-eslint/utils";
import { type BoundaryRule, boundaryListener, type HexRuleOptions, OPTIONS_SCHEMA } from "../hexagonal.ts";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

function boundaryRule(name: string, rules: readonly BoundaryRule[], lead: string) {
  return createRule<[HexRuleOptions?], "problem">({
    name,
    meta: {
      type: "problem",
      schema: OPTIONS_SCHEMA,
      messages: { problem: `${lead} {{detail}} (docs/architecture/layers-and-dependencies.md)` },
    },
    defaultOptions: [{}],
    create: (context) => boundaryListener(context, rules, (node, detail) => {
      context.report({ node, messageId: "problem", data: { detail } });
    }),
  });
}

/** domain <- application <- adapters inside a context; adapters never import
 *  each other; domain and application use no library but zod; apps reach
 *  contexts only through their export paths and never another app. */
export const layerDependency = boundaryRule("layer-dependency", ["layers", "apps"], "Layer boundary:");

/** A context never imports another context or an app, except an out adapter
 *  calling another context's application (the anti-corruption layer). */
export const noCrossContextImport = boundaryRule("no-cross-context-import", ["contexts"], "Context boundary:");

/** Browser code (`client/`, `renderer/`) imports server code as types only. */
export const clientTypeOnlyServerImports = boundaryRule(
  "client-type-only-server-imports",
  ["browser"],
  "Browser boundary:",
);

/** In adapters depend on in-port interfaces, never on handler classes. */
export const inAdapterUsesInPort = boundaryRule("in-adapter-uses-in-port", ["in-adapters"], "In-adapter boundary:");
