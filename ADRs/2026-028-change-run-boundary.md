# 2026-028: A change run is a new run — the guard log is the run boundary

**Status:** accepted

## Decision

The change cycle (TN-26-003, issue #14) enters as a **new run against the same
tree**, and the boundary is drawn by archiving the guard log
(`agent/scripts/bounded-change-run`, run by the driver from outside the session —
the same place role binding happens, so nothing inside a run can redraw its
own boundary).

This works because `.bounded/` holds two kinds of state with different lifetimes:

- **Tree state** — the contract manifest, the role binding, the model tiers.
  Describes the project; survives across runs.
- **Run state** — the guard log. Review freshness, the phase gate's spawn
  preconditions, green-requires-red (ADR 2026-017) and the timing block are
  all derived from it; the log *is* the run.

With a fresh log over a surviving manifest, every existing gate forces the
change sequence with no new logic: `design_gate` takes its re-freeze path
(manifest present) and blocks first on a *missing* review, so the changed
design must be re-challenged; the phase gate refuses worker spawns until that
re-freeze passes; `green_gate` finds no standing red, so a fresh shadow red
over the revised tests is mandatory; the timing block measures the change run
alone. The boundary re-arms the gates instead of duplicating them.

One gate needed an amendment (to ADR 2026-019's typecheck step):
**on a re-freeze, worker-owned drift does not block the freeze.** A change
revises the contract over a tree that already implements the old one, so the
tree failing to compile *is* the change — and repairing it is exactly what the
two workers are commissioned to do, which they cannot be until the freeze the
typecheck step was blocking. The step now lets diagnostics owned entirely by
the test-writer and builder through — printed, attributed per owner, and
recorded in the composite event as `typecheckDrift` — while anything
design-owned still blocks: a contract file, project config, or a *generated
skeleton*, whose diagnostics are the contract's own defects wearing the
builder's path (`isGeneratedArtifact` decides). A first freeze keeps the full
block: there `src/` holds nothing but skeletons and no tests exist, so every
diagnostic is the design's. `green_gate` still requires a fully compiling
project, so the false-green invariant is untouched.

`bounded change-run` refuses to draw a boundary through a live run (a log without
a final successful delivery, ADR 2026-053) unless `--force`d: re-entering an interrupted run is a resume
(`pi -c`, r20), which needs the log intact, not a boundary.

## Why

Everything else about change was already built: non-destructive scaffold
(ADR 2026-023) carries the implementation across a contract revision, shadow
red (ADR 2026-021) proves red independent of live `src/`, deliver is
idempotent and ships the delta. What was missing was an entry point — every
gate read one shared log as if runs never ended, so a second run inherited the
first run's review, freeze evidence and red. Rotating the log is the smallest
move that makes "new run" true for every gate at once. The typecheck amendment
resolves the one genuine deadlock: without it, a contract edit over delivered
code could never re-freeze (the drift blocks the gate) and the workers who own
the drift could never be commissioned (the phase gate waits on the freeze).
It also aligns the gate with TN-26-001's dispute protocol, which always said a
mid-loop contract revision is *freeze first, repairs after*.

## Consequences

A change request on a delivered tree is: `bounded change-run` → launch the
architect with the change → edit `spec.md` + contracts → commission the
reviewer (design_gate blocks until then) → re-freeze over the drift → both
workers in parallel (test-writer revises tests blind to `src/`, builder brings
the implementation along blind to tests) → shadow red → green → sign-off →
deliver. Harness-update recovery keeps its distinct path: resume, no boundary.

Still open from TN-26-003: review-as-diff (the reviewer re-reads the whole
design, not what moved), knowledge artifacts in the target, and adopting a
fresh clone whose `.bounded/` was never committed (the manifest is reconstructible
from the contracts, but nothing does it yet).
