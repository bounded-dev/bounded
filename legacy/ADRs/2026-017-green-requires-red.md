# 2026-017: Green requires a red for the current contracts, mechanically

**Status:** accepted

## Decision

`green_gate` refuses unless the guard log holds a `red_gate` pass AFTER the
most recent contract freeze. A checksum verify (no drift) does not void the
red; a re-freeze does. Companion decision: red-gate reachability is measured
by call sites in test sources (AST), with failure names as corroboration only.

**Amended:** a valid red requires *every* test to fail with
`NotImplementedError` against the regenerated skeleton. A passing test cannot
distinguish the intended implementation from no implementation; a skipped test
has not made a claim at all. One failing test must not hide either. The gate
names tests that passed or did not run and routes them to the test writer
(dogfood Run 20).

**Amended: the binding has two halves.** Since red moved into a shadow project
so the two workers could run in parallel (`.bounded/shadow-red`, rebuilt per run),
the workers move independently and a test can change after the red that covered
it. So a red-gate pass also records a sha256 of the whole `tests/` tree, and
green refuses unless the tree still hashes the same. Contracts: a red since the
last freeze. Tests: that red, over these tests. Either half missing is the same
false green in different clothes. The remedy for both is one call — `red_gate`
builds its own shadow project, so it neither needs nor touches `src/` and the
builder keeps working while it runs — and the test half routes to the
test-writer rather than the architect.

## Why

Run 10: a contract was revised mid-loop, re-frozen, red never re-established;
green ran and passed 148/148 — with the sign-off honestly recording that the
red could not pass. Without a red, nothing proves the suite CAN fail, which
is the pipeline's entire epistemic product. The ordering lived in the skill
as prose and prose executed unreliably, as it always has here. On its first
live day the guard turned the same violation into a 7-second self-correction.
The reachability redefinition exists because failure-name evidence is
structurally unavailable for any export whose inputs come from other exports
(Run 9 jammed five bounces deep on that impossibility).
