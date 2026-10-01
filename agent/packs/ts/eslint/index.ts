import { blessedStacksOnly } from "./rules/blessed-stacks-only.ts";
import { contractImportsContractsOnly } from "./rules/contract-imports-contracts-only.ts";
import { declarationOnly } from "./rules/declaration-only.ts";
import { entityShape } from "./rules/entity-shape.ts";
import { implTail } from "./rules/impl-tail.ts";
import { noBrandedAliases } from "./rules/no-branded-aliases.ts";
import { noNakedPrimitives } from "./rules/no-naked-primitives.ts";
import { noSchemaOnSurface } from "./rules/no-schema-on-surface.ts";
import { noTestRunnerInSource } from "./rules/no-test-runner-in-source.ts";
import { valueObjectDocumented } from "./rules/value-object-documented.ts";
import { valueObjectShape } from "./rules/value-object-shape.ts";
import { zodBackedParse } from "./rules/zod-backed-parse.ts";

// bounded-ts ESLint plugin (TN-26-001 zone lint rules, ADR 2026-007).
// Loaded programmatically by the gate scripts — target projects never
// hand-wire it. The contract-purity gate owns the contract flat config
// (`*.contract.ts`); the src gate owns the implementation config.
//
// Contract model (ADR 2026-059): value-object-shape, entity-shape,
// value-object-documented and contract-imports-contracts-only hold the
// interface + factory form; impl-tail holds the implementation file's hidden
// `<Name>Impl` and its two generated exports. Retired with the `declare
// class` form: value-objects-own-contract and no-cross-contract-type-import.
export const plugin = {
  meta: { name: "eslint-plugin-bounded-ts", version: "0.0.0" },
  rules: {
    "declaration-only": declarationOnly,
    "no-naked-primitives": noNakedPrimitives,
    "no-branded-aliases": noBrandedAliases,
    "value-object-shape": valueObjectShape,
    "entity-shape": entityShape,
    "value-object-documented": valueObjectDocumented,
    "contract-imports-contracts-only": contractImportsContractsOnly,
    "no-schema-on-surface": noSchemaOnSurface,
    "impl-tail": implTail,
    "blessed-stacks-only": blessedStacksOnly,
    "zod-backed-parse": zodBackedParse,
    "no-test-runner-in-source": noTestRunnerInSource,
  },
} as const;

export default plugin;
