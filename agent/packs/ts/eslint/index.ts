import { blessedStacksOnly } from "./rules/blessed-stacks-only.ts";
import { declarationOnly } from "./rules/declaration-only.ts";
import { noBrandedAliases } from "./rules/no-branded-aliases.ts";
import { noCrossContractTypeImport } from "./rules/no-cross-contract-type-import.ts";
import { noNakedPrimitives } from "./rules/no-naked-primitives.ts";
import { noSchemaOnSurface } from "./rules/no-schema-on-surface.ts";
import { valueObjectDocumented } from "./rules/value-object-documented.ts";
import { zodBackedParse } from "./rules/zod-backed-parse.ts";
import { valueObjectShape } from "./rules/value-object-shape.ts";
import { valueObjectsOwnContract } from "./rules/value-objects-own-contract.ts";

// bounded-ts ESLint plugin (TN-26-001 zone lint rules, ADR 2026-007).
// Loaded programmatically by the gate scripts — target projects never
// hand-wire it; the contract-purity gate owns the flat config:
//   files: ["src/**/*.contract.ts"] → bounded-ts/declaration-only
//                                   → bounded-ts/no-naked-primitives
export const plugin = {
  meta: { name: "eslint-plugin-bounded-ts", version: "0.0.0" },
  rules: {
    "declaration-only": declarationOnly,
    "no-naked-primitives": noNakedPrimitives,
    "no-branded-aliases": noBrandedAliases,
    "value-object-shape": valueObjectShape,
    "value-object-documented": valueObjectDocumented,
    "value-objects-own-contract": valueObjectsOwnContract,
    "no-cross-contract-type-import": noCrossContractTypeImport,
    "no-schema-on-surface": noSchemaOnSurface,
    "blessed-stacks-only": blessedStacksOnly,
    "zod-backed-parse": zodBackedParse,
  },
} as const;

export default plugin;
