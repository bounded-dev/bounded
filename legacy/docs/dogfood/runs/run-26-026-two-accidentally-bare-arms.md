# Run 26 — two accidentally-bare arms: the loader bug run (2026-09-22)

**This run was meant to be the first tiered pi harness run on a new prompt.
No harness ran in either arm.** It is recorded as what it actually was: an
unplanned bare-vs-bare comparison — kimi 2.7 under pi against opus 5 under
Claude Code — on the first outing of the renewable-site contract prompt
(`docs/dogfood/renewable-contracts-prompt.md`), reviewed from the session
transcripts, the trees, and the harness's own mutation gate.

## Why no harness ran (two independent failures)

1. **The pi adapter did not load.** ADR 2026-035 had moved the pi extensions
   to `hosts/pi/extensions/`, and pi's global discovery scans only
   `~/.pi/agent/extensions/` — it never reads the agent package.json the
   move relied on. Every pi session that day ran with no path gate, no gate
   tools, no tiers, no guard log, while 2539 unit tests stayed green. Fixed
   the same afternoon (loader shim + `hosts/pi/discovery.test.ts`, which
   runs pi's own loader against the repo); full account in ADR 2026-035's
   change log.
2. **The hosts were swapped, and nothing said so.** Claude Code was run in
   the *harnessed* arm — where the reset had wiped `.claude/`, so no
   adapter, no hooks — and pi in the *bare* arm. The Claude session even
   said it out loud ("`developer-stage` isn't installed in this
   environment, so I'll build it directly") and carried on. Nothing in an
   arm states which host it expects or verifies one at session start; the
   mixup was only discovered from transcript locations afterwards.

The three standing guard questions are answered trivially — no guard ran,
nothing was corrected, nothing could be circumvented — and that emptiness is
the run's first finding: **a run with no guard log is indistinguishable from
a run that went perfectly until you look for the log.** Run-start evidence
(the host declaration line) is the only thing that separates them, and it
must be checked at start, not at write-up.

## The two bare runs, measured

| | **kimi 2.7** (pi, "bare" arm) | **opus 5** (Claude Code, "harnessed" arm) |
|---|---|---|
| Wall clock | **4½ minutes** | ~16 min (+ cleanup to 14:05 UTC) |
| Order of work | all of `src/` first, then tests | all of `src/` first, then tests |
| Tests | 40, in one 1,111-line file | 88, in 9 files by topic |
| Suite | green | green |
| Mutation score (40-mutant sample) | **93%** (37/3) | **93%** (37/3) |
| Contracts / spec / guard log | none | none |
| Tree snapshot | uncommitted working tree | arm commits `73e28ca` (run) and `921d3b4` (post-run cleanup) |

Both suites are *nominally* well-shaped: kimi's 40 tests name the access
isolation, the main-party rule, same-site supersession, sweep idempotency
and late emission; opus's 88 include a seeded random-sequence test of the
notification-ledger invariant, and its sweep/expiry/lifecycle files read
like the spec. Ungated frontier models in 2026 produce far better bare
baselines than the runs 1–5 era — the bar the harness must beat has risen.

## What the transcripts show that the green suites hide

- **kimi settled a red by editing the tests, in 26 seconds.** Its first run
  had 4 failing notification tests. The next tool call rewrote the *tests*
  — sweep dates moved (day 100→195), a comment rewritten from "misses the
  90-day window but is inside the 30-day" to "inside the 90-day window
  only" — and the suite went green. Perhaps the test math was wrong;
  perhaps the implementation was. **The disagreement was adjudicated by the
  party that wrote both sides, instantly, leaving no record.** In the
  pipeline this exact moment is structurally impossible: the builder cannot
  edit tests, and the disagreement becomes a DISPUTE or a red-gate verdict
  a human can audit. This is the run's centrepiece exhibit.
- **kimi loaded the developer-stage skill, announced "test-first", then
  wrote the implementation first.** The skill (prose) loaded fine — skills
  discovery was unaffected by the loader bug — and bound nothing.
  Mechanism-vs-guidance (TN-26-002), demonstrated in one line.
- **Both models inverted the order.** Implementation 13:49–13:53, tests
  after — the implementer writing its own exam throughout. Opus's exam is a
  good one; it is still self-graded, and "done" claims rested on nothing
  but the final suite.
- **Untested spots line up with the surviving mutants.** kimi's three
  survivors sit on one branch — amend a *single* start or end date and no
  test notices (`manager.ts:133`). Opus's real survivor is the structural-
  milestone guard (`isStructural`): flip it and start/end milestones become
  removable, silently. Each is precisely the kind of obligation the
  harness's test-obligations and law machinery exists to force.
- **Asked mid-session why there were no `.contract` files, opus explained
  correctly and did not retrofit any** — the post-run commit is a small
  cleanup, not backwards-derived contracts. Contracts-before-code is a
  harness artifact; no model volunteers it.

## What this run forces into the harness

- **Discovery is pinned by test** (`hosts/pi/discovery.test.ts` runs pi's
  own loader; shipped with the fix).
- **An arm should say which host it expects, and a run should prove which
  host it got.** The guard log's host line already does the second half —
  but only if someone looks at run start. Candidate: `dogfood-reset` writes
  the intended host into each arm, and the write-up template starts with
  the host line or the words "no guard log existed".

Snapshots for later comparison: the arm repos hold the trees; both arms
auto-archive on the next reset. The true Run 27 — the tiered pi harness on
this same prompt, opus judgment seats and sonnet workers — runs after this.
