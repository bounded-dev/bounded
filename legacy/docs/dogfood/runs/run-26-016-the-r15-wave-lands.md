# Runs 16–19 (2026-09-09 – 09-11): the r15 wave lands, a real app arrives, and the first headless deliveries
Four pairs across three days, all harnessed, both arms each — the arc from "did
the r15 fix wave work" to "can the whole developer stage run with nobody
watching". Every pair runs the same two tiers: opus-5:high in the judgment
seats / sonnet-5:medium in the production seats (the **anthropic** arm), and
kimi-k3:high / k2p7:medium (the **kimi** arm). These are mechanism runs, not a
harness-versus-guidance comparison. Archive branches `r16-*`, `r17-*`, `r19-*`;
r18 has no named branch and is recorded here from the coordinator's notes.

Read this section as one story: r16 shakes out the r15 wave and finds a green
gate that still let a dead skeleton through; r17 is the first run on a *real*
application slice and the domain immediately finds a harness bug; r18 buys the
first uncontaminated timing card and exposes a review loop and a scaffolder bug;
r19 is the capstone — both arms deliver headless with zero human intervention.

### Run 16 — first pair after the r15 rework

The first pair with the whole r15 fix wave live: one class identity per value
object, the non-clobbering scaffolder, `deliver` installing its `ts-morph` pin
and running the target's own `npm run check`, role-scoped `typecheck`, `sleep`,
`mutation_score`, and the run-start marker. Both arms reached green on the
subscription-billing prompt.

| | anthropic (opus-5 / sonnet-5) | kimi (k3 / k2p7) |
|---|---|---|
| **Result** | GREEN 179/179, ~35 effective min | GREEN 139/139, ~33 effective min (r15 was ~69) |
| **Mutation score** | 83%, 7 survivors carried into sign-off | 88% → **100%** via the measure-loop |
| **Review cycles** | 6+, plus 2 mid-build re-freezes | 5 |

**1. `deliver`'s NotImplementedError backstop blocked on a *dead skeleton* that
green had passed 179/179 — twice.** The anthropic arm shipped a `billing.ts`
whose exports no test imported: a red-phase skeleton that reached green because
nothing exercised its throwing exports, so `green_gate` (which runs the suite
and a typecheck, not an export census) saw nothing wrong both times it ran. Only
`deliver`'s import scan, walking every export rather than every test, caught the
still-`NotImplementedError` surface. The builder fixed it and re-delivered
clean. This is the catch that motivated moving the skeleton scan into
`green_gate` itself (commit `7729c3c`, "green catches skeletons") — the backstop
should not be the first thing in the pipeline to look.

**2. The mutation-score loop ran for the first time, and it worked.** The kimi
arm measured 88%, added tests for the survivors, re-established red, and re-green
to **100%** — `mutation_score` invoked live twice, the advisory tool used as the
loop ADR 2026-023's neighbours imagined. The anthropic arm did *not* loop: it
measured 83% and carried its seven survivors into the sign-off findings instead.
Both are legitimate uses of an advisory measure; the contrast is worth keeping.

**3. No clobber, cheap re-red.** The anthropic reviewer drove six-plus design
cycles and two *mid-build* re-freezes, and neither re-freeze destroyed a
finished implementation — the non-clobbering scaffolder held, and each re-freeze
cost only a cheap re-red. This is the r15 finding-3 fix (28 minutes of rebuilt
work) not reproducing.

**4. `sleep` replaced the gate-as-clock.** The anthropic arm used `sleep` for
real waits; neither arm fired a gate to pass the time, which r15 did five times.

**Finding against the harness:** the kimi arm's run-start marker bound to a
*subagent* session (12:57:35) rather than the architect's, skewing its phase
card — so r16's per-phase splits are **not reliably recorded**, and the marker's
role-binding was queued as a real defect. (Fixed in the r19 wave: run-start now
binds to the architect — commit `7729c3c`.)

### Run 17 — the first real application slice

The first run on a slice of a *real* application rather than the
subscription-billing exercise: the PKE heating-cockpit ingest-and-rating core
(a new prompt — numeric value objects for temperatures, spreads, availability
fractions, and a banded rating). The domain immediately earned its keep.

| | anthropic (opus-5 / sonnet-5) | kimi (k3 / k2p7) |
|---|---|---|
| **Result** | GREEN 258/258, delivered, passes own check | GREEN 132/132, delivered, passes own check — after a **session restart** |
| **Mutation score** | 95% | 83% |
| **Timing** | not recorded in the card | not recorded in the card |

**The domain surfaced a genuine harness bug: the value-object law suite was
self-contradictory on numeric ranges.** The scaffolder generates a law suite
that asserts every value object *rejects* the numbers 0 and −1 as "hostile"
inputs — a fine assumption for ids and currencies, and wrong for numeric value
objects whose valid ranges include them (Kelvin 0–80, Percent 0–100, and so
on). A `Percent` that must accept 0 cannot also reject it, so the generated law
directly contradicted the equality laws in the same suite.

The kimi arm is the clean demonstration: its developer-stage architect **refused
to bend `parse` to satisfy a wrong test**, arbitrated the builder's dispute, and
**escalated** because the fix lay in the pack — outside any role's write zone.
The fix (hostile inputs filtered by the value object's base type, so a numeric
VO is never asked to reject a number in its range) is commit `215dc08`. The
mid-run fix could not reach the running process — Node's module cache had the old
pack loaded — so the arm needed a session restart, after which it went
**128 → 132 tests with zero code change** once the laws were corrected. The
anthropic arm self-healed past the same bug via a post-fix re-freeze.

This is the honest shape of a good dogfood finding: a real domain (not a
contrived probe) exercised an assumption the harness had baked in for a
different domain, and the escape hatch was the architect refusing to make the
implementation wrong to make a wrong test pass.

### Run 18 — the first uncontaminated timing card (no named branch)

A run aimed at a clean timing card, on the cockpit slice. Recorded here from the
coordinator's notes; there is no `r18-*` archive branch.

**(a) The anthropic arm produced the first uncontaminated timing card.**

```
design 43m15s · tests 2m05s · build 3m59s · wrap 1m59s · TOTAL 51m53s
friction 1 refusal / 4 iteration · GREEN 258/258
```

Analysis of that 43-minute design phase showed roughly 20 minutes were the
reviewer *polish loop*: cycles past a zero-blocker review that added a regression
and then removed it (cycle 2 found 0 blockers; cycle 3 reintroduced one via the
architect's own edit). That is the finding that motivated the **one-round-trip
review reframe** — ADR 2026-020 amended so review is a single fresh-eyes
*challenge*, not a byte gate: across r15–r18 no second-or-later cycle ever caught
a defect the first pass missed, and byte-freshness mis-scoped the trust boundary
(it policed the *trusted* architect's edits). Freshness was relaxed from
byte-exact to the file *set*, so only adding or removing a contract file
re-requires a review (commit `0d1bdab`).

**(b) The kimi arm hit a second harness bug from a single-file mega-contract,
and did not deliver cleanly.** Its scaffolder `__conformance` annotation was
`typeof __Contract` — the whole contract namespace — while the conformance
object omitted the nominal value-object classes, so a file mixing value-object
classes with functions scaffolded to non-compiling code ("separate declarations
of a private property `__brand`"). Fixed by narrowing the annotation to
`Pick<…>` of exactly the exports the object carries (commit `b684e17`). As in
r17, the mid-run pack fix could not reach the running process (module cache); the
arm needed a restart and then **stalled** — kimi r18 recorded no clean green.
This same single-file-mega-contract shape is what later motivated ADR 2026-026
(value objects live in their own contract file), enforced by the
`bounded-ts/value-objects-own-contract` lint rule, so decomposition is now a
contract-shape rule the architect meets up front rather than a scaffold-time
surprise.

### Run 19 — the capstone: both arms headless, zero intervention

The first run with both the one-round-trip review *and* the decomposition rule
(ADR 2026-026) live. Both arms were launched **headless** — `pi -p`, no
interactive session — and both delivered with **zero human intervention, zero
escalations, zero restarts**, each passing its own `npm run check`. Archive
branches `r19-anthropic-harness`, `r19-kimi-harness`; the live guard logs
(`~/dev/pi-harness-dogfood-{harnessed,bare}`) are the same two runs and carry the
full phase splits.

| | anthropic (opus-5 / sonnet-5) | kimi (k3 / k2p7) |
|---|---|---|
| **Result** | GREEN 211/211, delivered headless | GREEN 208/208, delivered headless |
| **Design phase** | 20m08s | 15m09s |
| **Total** | 33m06s | 23m26s |
| **Mutation score** | 90% (4 survivors, confessed at sign-off) | **100%** (via the measure-loop: 205/205 @95% → 208/208 @100%) |
| **Review cycles** | **1** (16 findings, 2 blockers, settled + frozen) | **1** |
| **Design shape** | 6 contract files | decomposed, value objects in their own `values.contract.ts` |
| **Sign-off** | 7 findings, 0 blockers | 4 findings, 0 blockers |
| **Friction / iteration** | 4 refusals (path-gate) / 2 (lint-src, typecheck) | 2 refusals (path-gate) / 13 (run_tests 6, typecheck 4, git 3) |

**1. The review reframe halved the design phase, as predicted.** The anthropic
arm's design ran **one** review cycle (16 findings, 2 blockers, all settled by
the architect and frozen) against r18's four, and design fell from 43 minutes to
20 — the one-round-trip reframe doing exactly what its ADR said it would. A
single fresh reading, the architect deciding, the freeze.

**2. The decomposition rule steered kimi multi-file proactively rather than
blocking it.** The arm that gave us two single-file-mega-contract bugs (r18, and
the r15 impasse before it) delivered a decomposed design this time — value
objects in their own `values.contract.ts`, operations in separate contract files
importing them from the implementation module — with the rule shaping the design
up front rather than refusing a frozen contract. The anthropic arm independently
decomposed into six contract files with its value objects similarly separated.
**Cross-model convergence is the result worth stating plainly:** two very
different models, given the same rules, delivered the same architectural shape.

**3. kimi's first clean end-to-end run, ever.** r15 ran ~69 minutes; r17 needed
a restart; r18 stalled. r19 is the first time the kimi arm went prompt-to-deliver
with no restart, no stall, no intervention — and at 23m26s, its fastest.

**4. The mutation loop closed to 100% on the kimi arm, headless.** It measured
95% (205/205), added tests for the two survivors, re-established red, and
re-green to 208/208 at 100% mutation — the r16 loop, now run with nobody
watching. Its sign-off records the two survivors it fixed mid-loop and one spec'd
rule it *removed* by arbitration (a `minimumAvailability > 1` check that
`AvailabilityFraction` already makes unreachable), which is the sign-off doing
its job.

### Caveats — and the honesty that has to travel with these numbers

**Green plus a high mutation score is not proof of domain correctness.** It says
the suite pins the behaviour it covers and that shipped lines cannot change with
the suite still green — it does not say the behaviour is *right*, or that the
important cases are covered. Earlier deep inspections found real domain bugs
sitting behind green, high-mutation suites: the Runs 10–12 six-cell grid, and
above all r15, whose line-by-line inspection found two composition defects
shipped green (a spend cap a downgrade-then-upgrade defeats; a plan change across
an interval enum mis-prorating a year across a month) that nothing reading
operations one at a time could see. **r19's delivered code was not adversarially
inspected** the way r15's was — its quality is asserted from green, mutation, and
sign-off, not from a hostile read. The anthropic arm's own sign-off names a real
example of the gap: a genuine coverage hole where `ReportingPeriod.parse` never
round-trips two of its three tertile forms, found by the architect, not by any
gate. Treat the r19 headline as "the pipeline ran clean and delivered", not as
"the code is correct".

Two arms per pair, one task per pair (r17–r19 on the cockpit slice, r16 on
subscription-billing), still one component in one worktree. Integration —
several components, several architects, a merge — remains untested. r16's
per-phase timing is not reliable (the run-start marker bound to a subagent);
r17's cards carry no timing at all; r18 has no archive branch. Mutation scores
are a 40-mutant sample per run, not an exhaustive census.
