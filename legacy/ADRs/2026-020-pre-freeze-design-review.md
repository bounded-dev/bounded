# 2026-020: The design is challenged before it is frozen

**Status:** accepted (amended 2026-09-11 — see Amendment)

## Decision

A read-only `reviewer` role reads `spec.md` and every `*.contract.ts` as the
two blind consumers will have to, once, and records the challenges it raises
with `record_design_review`. The record names the SET of files it covered
(carrying a sha256 per file as provenance).

`design_gate` gains a `design-review` step between the typecheck and the
freeze: it requires the latest recorded review to have covered the current SET
of contract files, and otherwise refuses to freeze, saying which of the two it
is (never challenged, or a contract file added or removed since, naming it) and
routing to the architect. Latest is by append order, the same rule green-gate
uses for the red it requires. Editing a file the review already saw does NOT
stale it (see Amendment).

**Findings are advisory.** The gate decides only existence and coverage, which
a machine can decide; the architect — the trusted author of the spec and the
contracts — weighs the content and decides, which it cannot. No finding fails
the gate, a blocker included; the passing line prints the blocker count so an
unsettled one stays visible in the transcript.

**The findings travel with the record.** Every rendering of a review prints
each finding verbatim — severity, summary, evidence — in `record_design_review`'s
own result and again in the `design_gate` step that replays the record out of
the guard log. A count is an index into a document nobody can open: r15's
architect commissioned a review, got a count back, reached for `git` three times
hunting for the text, and finally revived the reviewer as a subagent purely to
make it recite findings the tool had already stored. Findings are the
deliverable of the role, so they are returned, not merely counted.

## Why

Run r13 measured the bill for discovering a contract defect late: ~30–38
minutes per defect, arriving as type errors once the test-writer was already
building on the frozen contract, and every one of them legible in the contract
before a single test existed. The only pre-freeze quality signal was
"commission the test-writer and see what explodes", which works and costs a
phase.

ADR 2026-014 says why this is a role with a checklist and a recording tool
rather than an instruction to be careful: a persona does not hold, and prose
executes unreliably. So the review is a checklist the reviewer walks, a tool
that records the answer including "I found nothing", and a deterministic
freshness lock — the only three parts a machine can keep honest.

## Consequences

Re-review is owed only when the contract file SET changes — a file added or
removed. A content edit to a file the review already saw does not block the
freeze (see Amendment), so the architect revises freely in answer to a finding
and pays for a fresh review only when the design's shape genuinely changes.

The reviewer decides nothing. It holds no write zone, no gate tool, and no
verdict; "gate" stays false of it, and an architect that could record its own
review would be doing the first reading again rather than a second one, so
`record_design_review` is the reviewer's alone.

The post-red suite-adversary variant of the same idea — a reviewer over the
tests once the red stands — remains open in issue #13.

## Presentation: fail loud early, pass silent in order

A gate's failure output and its success output answer different questions. On
failure the reader wants the cheapest true statement, as early as possible —
hence the freshness check running first on a re-freeze (ADR 2026-019). On
success the reader wants the canonical sequence, because that is what teaches
the phase. So an early failure is reported loudly with the steps it never
reached listed as not-run, and an early pass is silent: the run continues and
reports purity → scaffold → typecheck → design-review → freeze as always.

## The stopping rule

One review is enough. The gate asks two questions — does a review exist, did it
cover the current set of contract files — and once both are yes the phase is
over, whatever the findings say. Findings are settled by the architect's
decision, recorded in the design or in writing at `sign_off`; they are not
settled by looking again. A re-review is owed only when a contract file is
added or removed, and reads the whole design as it then stands rather than a
diff. Run r14's kimi arm spent nine review cycles polishing advisory findings
the gate had never asked about, which is the failure mode this rule names: an
advisory role can absorb unbounded time unless the stopping condition is
written down.

## Amendment (2026-09-11): a fresh-eyes challenge, not a byte gate

The original freshness lock was byte-exact: any edit to any reviewed file
changed a hash and staled the review. That forced a re-review after every
contract edit and drove multi-cycle looping. Two things were wrong with it.

**No later cycle ever earned its cost.** Across dogfood runs r15–r18, no
second or later review cycle caught a defect in the original design that the
first pass had missed; later cycles only re-verified fixes or cleaned up churn
the architect's own edits introduced (r18 anthropic: cycle 2 found 0 blockers,
cycle 3 reintroduced one via an architect edit). The first fresh reading is
where the value is; re-readings of a design the architect has been revising are
not a fresh mind.

**Byte-freshness mis-scoped the trust boundary.** The harness distrusts the
BLIND roles (test-writer, builder); the architect is the TRUSTED driver with
full authority over the spec and the contracts. Policing whether the architect
saw the final bytes treats the driver like an untrusted worker. So the review
is reframed as a one-round-trip, fully-advisory CHALLENGE: a fresh mind reads
the whole design once and records what it would push back on; the architect
hears it and decides, keeping authorship and authority. Freshness becomes
file-SET, not bytes — the whole design is challenged once, and only adding or
removing a contract file (surface never seen) re-requires a review.

This is safe because the objective defects a blocker names — an uncallable
operation, an unconstructable type — are already caught mechanically by
`design_gate`'s scaffold+typecheck step and by red/green/surface downstream. So
what the reviewer is left with is exactly the judgment-level challenge
(composition, ambiguity, shape) that is the architect's call anyway, which is
why every finding, blocker included, is advisory.
