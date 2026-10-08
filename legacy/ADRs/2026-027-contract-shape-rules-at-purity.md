# 2026-027: Contract-shape checks belong at contract-purity, not scaffolder fail()

**Status:** accepted

## Decision

A contract-SHAPE rule — one that says what a `*.contract.ts` may or may not
contain — belongs at `contract_purity` as an ESLint rule, not in the
scaffolder's `fail()`. Purity is the FIRST step of `design_gate`, and every
purity rule-id is named in the architect brief via guard-doc-drift, so the
architect is told the rule up front instead of learning it by bouncing. A
scaffolder `fail()` is neither: it fires a step later and sits outside the
rule-id/brief-drift system (ADR 2026-018), so it is a rule the architect meets
only as a block.

The r19 layer audit checked the three contract-shape enforcements still living
only in `scaffold-contract.ts`. Two were already covered at purity and needed
no new rule:

- **enum → string-literal union** — already refused by `declaration-only`
  (`enumRuntime`), with the same "use a string-literal union" remedy.
- **exported `declare class extends Base`** — already refused by
  `value-object-shape` (`classExtends`), with a reason.

The third was genuinely un-briefed and passed purity clean, so it moves:

- **cross-contract type import / re-export** — a new rule,
  `bounded-ts/no-cross-contract-type-import`. In a `*.contract.ts`, an
  `import type … from "…contract.js"` or `export type … from "…contract.js"`
  (any `.contract` specifier) is an error, naming the implementation specifier
  to use instead. This is the cross-FILE twin of `value-objects-own-contract`
  (ADR 2026-026, same-file), so the whole "one identity per value object"
  concern (ADR 2026-023) now lives coherently at contract-purity — same-file in
  one rule, cross-file in the other. A sibling rule rather than an extension:
  the two walk different AST shapes (same-file type references vs module
  specifiers) with different fixes (split the file vs re-point the specifier),
  and the cross-file rule fires on any type from a sibling contract, value
  object or not.

All three scaffolder `fail()`s are KEPT as backstops — defense-in-depth, the
last line if purity is ever bypassed — each now carrying a comment that names
the purity rule which catches it first.

## Why

The layer principle: a scaffolder `fail()` is bounce-only and un-briefed, so a
shape rule enforced only there taxes every run with a block the architect could
not have anticipated. The same reasoning moved `value-objects-own-contract` off
a scaffolder `fail()` in ADR 2026-026. The cross-contract case was the last
shape rule still split — same-file at purity, cross-file at the scaffolder —
which left the dual-identity concern (ADR 2026-023) incoherently in two layers.
Enum and extends turned out already correctly placed (they predate this audit),
so the audit's job for them was confirming the coverage and documenting the
scaffolder fails as backstops, not duplicating a rule.

## Consequences

Cross-contract dual-identity is now caught at the first design_gate step with an
actionable message naming the impl specifier, and named in the architect brief
and the `ts-contract-authoring` skill — an earlier, briefed bounce instead of a
scaffold-time crash (r15's 41-error unsatisfiable red is refused at purity). The
dual-identity concern is enforced in one place, contract-purity, across both its
same-file and cross-file forms. No behaviour is duplicated: enum and extends
keep their single purity rule; the scaffolder `fail()`s remain solely as
backstops for a bypassed purity, documented as such.
