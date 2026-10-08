# Runs 13–14: the composite gate, then the first reviewer
Run between the composite design gate landing (2026-09-07) and the mechanism
wave it and its successor motivated (2026-09-09). Two pairs, harness arm only —
these runs were testing new mechanism rather than re-measuring the
harness-versus-guidance contrast. Same task and the same two
models throughout (sonnet 5, kimi). **r13** is the first pair to run the
composite `design_gate` (ADR 2026-019). **r14** is the first pair with a
`reviewer` reading the design before the freeze (ADR 2026-020). Archive
branches `r13-sonnet-harness`, `r13-kimi-harness`,
`r14-sonnet-harness-aborted`, `r14-kimi-harness`.

Every number below is read from the run's own guard log, through the timing
block `deliver` prints.

### Where the minutes went

| | r13 (composite gate) | r14 (+ reviewer) |
|---|---|---|
| **sonnet** | 64 min end to end — design 45, tests 8, build 10, wrap 1; 3 sign-off findings | **aborted** ~52 min in, before any red: a design reviewed in 14 min, then a suite that would not run |
| **kimi** | 98 min — design 52, build 44; red established out of order; sign-off empty | **GREEN 106/106 in 67 min** — design 41:47 including NINE review cycles; build 44 → 9; 38 unrouted blocks [†]; 1 sign-off finding |

[†] **Read under the later split (r15).** "Unrouted blocks" was one counter
covering two different things, and most of these 38 were the second: workers
compiling and running their own suites and seeing red, which is the job. The
counter has since been split — `friction:` counts refusals only, `iteration:`
counts worker red-loops — and the honest reading of this row is "mostly
iteration". The number is left as it was printed.

### What the reviewer bought

**1. Defect discovery moved to where it is cheap.** r13 priced late discovery:
a contract defect surfacing as type errors once the test-writer was already
building on the frozen contract cost 30–38 minutes each, and every one of them
was legible in the contract before a single test existed. In r14 the same class
of defect surfaced pre-freeze, at minutes per review cycle. kimi is the clean
demonstration: **its build phase fell from 44 minutes to 9**, and the reason is
legible in the log — the reviewed contract survived contact with the builder
instead of being re-litigated mid-loop. The design phase absorbed the time
instead (41:47 of a 67-minute run), which is the trade the reviewer exists to
make.

**2. The freshness lock fired live and forced an honest re-review.** The gate
refuses to freeze a design whose bytes have moved since the review that covered
it. It blocked in-run, named the files that had moved, and the architect
commissioned the reviewer again rather than freezing. This is the ADR 2026-014
pattern holding once more: the *existence and freshness* of a review is
mechanism, its content is judgment, and only the first half survives being
merely written down.

**3. Nine review cycles is the failure mode of an advisory role.** kimi spent
nine on a gate that had never asked for more than freshness — advisory findings
polished until they ran out. An advisory role with no stopping condition will
absorb whatever time is available, so the condition is now written into the
architect's brief and ADR 2026-020: **zero blockers means freeze now**; concerns
and notes are settled by the architect's decision, in writing at `sign_off` if
they survive; a re-review is owed only when bytes changed.

**4. An 18-second re-review is a question, not a result.** One re-review in r14
returned in 18 seconds. Nothing checks that a review was *read* — the gate
checks that one exists and covers the current bytes — so whether that was a
fast read or a stamp is **unverified**, and it is the obvious next thing to
measure. A review whose cost approaches zero is a review whose signal is
unmeasured.

### What these runs forced into the harness

Each of these landed after the runs, motivated by them:

- **Red moved into a shadow project.** Both kimi arms died the same way: the
  builder had already implemented the contract when red was called, so no
  failure could be a `NotImplementedError` any more, and the only route back to
  red was **re-freezing the contracts to wipe `src/`**. The red gate now
  rebuilds `.pi/shadow-red` from the contracts, the tests and the config and
  proves red there, so a valid red is establishable at any moment — which is
  also what makes the two workers parallel rather than sequential. Green is
  bound to that red in both directions: the contract manifest, and a hash of
  the `tests/` tree, so a test edited after the red voids it (ADR 2026-017).
- **Spawn control by shape.** Twice across the two pairs the architect wrapped
  both workers in a `workflowScript`, and the gate — seeing one `subagent` call
  carrying a string — let it through with no precondition checked. Twice more
  it spawned `delegate`, the general write-capable worker, which carries no role
  binding and therefore no zone. Both forms are now refused by shape
  (ADR 2026-021): a gate cannot follow a script it never watches run, nor bind
  a role to a child it never sees named.
- **Forbidden tools removed rather than refused.** Both r14 arms spent whole
  turns on tools their role does not hold — refused, but still visible, so the
  model kept planning around them. Bound sessions now lose them from the
  toolset at `session_start`.
- **The scaffolder became a sync.** r14's architect deleted a scratch contract
  and its generated skeleton and law suite stayed behind, in write zones the
  architect does not hold: ~10 minutes and two failed `delegate` spawns for two
  files nobody wrote. Deleting the contract is now the whole gesture — the next
  `design_gate` prunes what the vanished contract generated, marker-gated, and
  a blocked run prunes nothing.
- **The re-freeze checks the review first.** r14 paid a full purity + scaffold
  + typecheck pass, repeatedly, only to be told at step four to go and
  commission the reviewer.
- **Friction became a printed number.** kimi's r14 arm ended with **38 unrouted
  blocks** and no single line in the run said so. Every delivery timing block
  now ends with a `friction:` line, counted by guard and printed even at zero.
  Bounces have a budget; friction has a target, and the target is 0.

  *Amended after r15.* "Unrouted blocks" turned out to be two things in one
  counter, and calling all of them friction made the headline lie: r15's kimi
  arm printed `31 unrouted blocks (typecheck 13, run_tests 8, git 4, …)`, which
  reads as a harness at war with its own workers, while the transcript showed
  21 of them were workers seeing their own red and exactly ONE call in the whole
  run was refused. The counter is now split by guard name — `friction:` for
  refusals (the call did not happen; target 0, printed even at zero) and
  `iteration:` for worker red-loops (`typecheck`, `run_tests`, `lint-*`; the
  call happened and told the truth; no target, printed only when non-zero).
  `git` counts as iteration too: a non-zero `git log` on a path that never
  existed is a search that missed, not a refusal.

### Caveats

Two arms per pair, one task, one domain: these are mechanism tests, not a
quality comparison, and nothing here re-measures the harness against guidance.
The sonnet r14 arm never reached a red, so it contributes evidence about the
design phase and nothing about the rest. And the r13/r14 timing splits were
produced by the phase-duration telemetry landed the same week — read them as
this instrument's first live readings.

---
