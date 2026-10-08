# LEG-2026-023: One class identity per value object; scaffold is a non-destructive sync

**Status:** superseded by LEG-2026-059

## Decision

**One identity.** Across a scaffolded project there is exactly one class
identity per value object: the runtime class the scaffolder writes into the
VO contract's sibling implementation module. Every other module reaches it by
importing that module. A contract may therefore not import types from, or
re-export types from, another contract's `*.contract.ts` — it imports the
implementation module (`../values/values.js`), which re-exports every type its
own contract declares and shadows the ambient class with the real one. The
scaffolder rejects anything else with a `ScaffoldError` carrying the exact
replacement import; the architect fixes the contract, never the skeleton.

**Non-destructive sync.** The scaffold step writes a skeleton only where the
target is absent or is itself a generated skeleton (the same marker that
licenses the orphan prune). A target with real content is SKIPPED with a loud
line and a guard event, never overwritten.

## Why

Run r15 supplied both halves. A contract declaring nominal value objects
(ADR LEG-2026-015) is scaffolded into a runtime class, so `declare class Money`
and `class Money` are two declarations of the same private `__brand` — which
TypeScript treats as unrelated types. Any *other* contract whose operations
reached `Money` through `values.contract.js` therefore declared operations
over a type nothing could produce, because `Money.parse` — the only legal door
in — returns the other one. The shadow red carried 41 `separate declarations
of a private property '__brand'` errors, the tests could not construct a value
through any legal route, and the architect invented eight `parse*` boundary
functions and re-froze mid-loop to make red satisfiable: ~44 of that arm's 76
live minutes, and a sign-off recording "red-phase typecheck is unsatisfiable".
Redirecting only the generated skeleton's imports is not enough — a contract's
own interfaces (`Receipt { total: Money }`) carry the wrong identity too — so
the second declaration must be unreachable, which only the contract can
arrange. Separately, that re-freeze ran the scaffold step over two finished
arms and overwrote implementations in both; one survived on a lucky
`git add -A`, the other rebuilt 28 minutes of work.

## Consequences

Contracts import cross-component types from implementation modules, so a
component's public surface is its module and its contract is private to its
own skeleton. Contract authoring guidance and the worked example in
`packs/ts/skills/ts-contract-authoring` must say so. Contract drift against a
kept implementation is not silent: it surfaces as type errors in design_gate's
typecheck step and green's surface check, both routed to the builder — the
only role that can reconcile them. Red-gate is unaffected: its shadow project
is wiped and rebuilt, so every skeleton there is still regenerated. A test
that imports a value object from a `*.contract.js` reintroduces the second
identity in its own file; today that is a loud local type error at red rather
than a gate rule.
