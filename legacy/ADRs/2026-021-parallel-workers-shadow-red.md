# 2026-021: The workers run in parallel; the gate checks the spawn form

**Status:** accepted

## Decision

The test-writer and the builder are commissioned **in parallel** once the
design is frozen. The phase gate's precondition for either worker is the
freeze — contract, spec, purity, skeletons, manifest — and nothing orders the
two against each other. The builder's old "red_gate has not passed" refusal is
removed.

Ordering is unnecessary because the red no longer depends on the live tree:
`red_gate` proves red in a shadow project it rebuilds itself (`.bounded/shadow-red`
— contracts, regenerated skeletons, a copy of `tests/`), so a builder writing
`src/` at the same moment cannot contaminate it. `green_gate` then requires a
red since the last freeze **and** over the current `tests/` hash, so ADR
2026-017's green-requires-red survives strengthened: the red is bound to the
bytes it was proven against rather than to a moment in the run.

Two spawn shapes are refused outright, for any session holding a bound role:

- **A multi-spawn form naming a pipeline role.** A `subagent` input carrying
  `workflowScript`, or a `chain`/`parallel` item array, whose text mentions
  `architect`, `test-writer`, `builder` or `reviewer` is blocked whatever the
  phase. Pipeline roles are commissioned one at a time through the plain spawn
  form. A multi-spawn form naming no pipeline role passes through untouched and
  logs one `phase-gate` pass event naming the form.
- **`delegate`.** The general write-capable worker holds no role binding, so
  the path gate has no zone to apply to it. `scout` and `product-expert` are
  read-only and stay available.

## Why

Runs r13 and r14 measured both halves. The sequential rule was fighting the
zone design rather than protecting anything: red and green are hash-bound, and
holding the builder behind a red bought an ordering the hashes already
guarantee, at the cost of a serialized phase.

Meanwhile the rule was not even holding. Twice, an architect spawned both
workers inside one `workflowScript` (`runs.all([...])`) — a form the gate never
inspected, so the builder ran with no precondition checked and no model tier
injected. Twice more, an architect spawned `delegate` inside the pipeline, an
unbound writer with no zone. Both are refused by shape, because shape is the
only thing checkable here: a gate cannot evaluate a precondition per child
inside a script it never watches run, and it cannot bind a role to a child it
never sees named.

## Consequences

Every pipeline spawn now passes through the plain form, so tier injection and
the commissioning event cover all of them; the guard log gains a `fan-out`
event for the legitimate multi-spawn case, so an unexplained cluster of
children is traceable to the call that started it.

The architect's only remaining ordering duty is freeze-before-workers. It
commissions both, and reacts to whichever returns first.

`deliver` removes `.bounded/shadow-red/` — it is a second copy of the tests beside
the real one, reproducible at any time by running `red_gate` again. Dogfood
arms are scaffolded with `.bounded/` gitignored from birth, so an archive never
commits a shadow tree or a guard log.
