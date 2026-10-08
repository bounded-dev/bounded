# LEG-2026-026: Value objects live in their own contract file

**Status:** superseded by LEG-2026-059

## Decision

A value object and the interfaces / type-aliases / operations / consts that
reference it may not share a `*.contract.ts` file. Value objects live in their
own contract file(s) — a vocabulary file may hold several, since one value
object referencing another does not clash — and the operations over them import
them from the sibling IMPLEMENTATION module (`../ids/ids.js`), exactly the route
ADR LEG-2026-023 already mandates for cross-component types.

Enforced by a new contract-purity lint rule,
`bounded-ts/value-objects-own-contract`: in a `*.contract.ts`, an exported
interface, type-alias, function, or const that references a same-file nominal
value-object class (private `__brand`, private constructor, `static parse`) is
an error, naming the value object to move. Not a scaffold-time failure: it is a
contract-shape rule like its neighbours, it fires one gate earlier, and it is
named in the architect brief so the rule is known up front rather than met as a
block (guard-doc-drift).

## Why

The same-file twin of ADR LEG-2026-023, which that ADR's cross-contract refusal did
not cover. A value object is a nominal `declare class` the scaffolder turns into
a RUNTIME class in the contract's skeleton. When the same file also references
that value object, the reference is emitted against the runtime identity while
the skeleton's compile-time conformance check compares the same export against
`typeof __Contract` — the contract's AMBIENT `declare class`. Two declarations
of the same private `__brand`, and the skeleton does not compile: "separate
declarations of a private property '__brand'". The contract is purity-clean and
freezes, yet scaffolds to non-compiling code — dogfood r18/r19 hit it as the
third bug of one arm's single-file mega-contract, while multi-file designs were
clean because they already import value objects from the implementation module.
The skill's own canonical worked example (`OrderId` beside `findOrder(id:
OrderId)`) demonstrated the bug. The rule enforces the architect brief's
existing "one cohesive area per contract file": a value object is its own area;
the operations over it are another.

## Consequences

The scaffolder no longer emits non-compiling skeletons from a frozen,
purity-clean contract of this shape — the contract is refused at design time,
with an actionable message that names the value object to move and states it
belongs in its own `*.contract.ts` with the operations importing it from the
implementation module. Decomposition is now enforced, not merely advised. A
reference laundered through a same-file interface does not clash at compile time
(the skeleton imports the interface from the contract, so both sides carry the
ambient identity), but it is refused all the same, because the decomposition is
architectural. The `ts-contract-authoring` skill's worked example and
parse-boundary guidance, and `agents/architect.md`, name the rule and use the
decomposed shape.
