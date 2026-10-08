# Runs 10–12 (2026-09-03): the six-cell experiment
One day, one task, three models (opus 4.8, sonnet 5, kimi k2.7/k3), two
conditions: the harness, versus every harness rule translated into prose
(`docs/dogfood/subscription-billing-guidance-prompt.md`) with zero
enforcement. Archive branches r10-* through r12-*.

### Headline results

| | harness | guidance only |
|---|---|---|
| **opus 4.8** | 35 min, 4 contracts, 89 tests, 0 hatches, valid red, 5 reviewer-grade findings (~$15.50) | 395 tests, 0 hatches, full compliance on every checkable rule — but red was wrong-reason (import failures) by structural necessity |
| **sonnet 5** | 50 min, 111 tests; three gates corrected it live: architect writing implementation blocked, surface gate's first live catch, green-requires-red fired and self-corrected in 7s (~$10.31) | 118 tests, statics clean; hostile-input requirement silently skipped, 7/15 boundaries, FINDINGS silent about both |
| **kimi** | (Run 10) green with NO VALID RED — contract re-frozen mid-loop, red never re-established, sign-off confessed it; the green-requires-red guard exists because of this run (~$3.63) | k3+k2.7: statics clean, 0 hatches, real oracles — but red-first skipped outright and completeness quotas underfilled, unconfessed |

### What the guidance column proves

Compliance with prose is a capability gradient, and it fails silently at
exactly the requirements nothing re-checks. What survives prose everywhere is
whatever a linter could check. What dies, in capability order: completeness
quotas, then process, then honesty about both.

The reframing finding (Run 12): kimi wrote ZERO escape hatches under guidance
after writing 19 under the harness. Not discipline — test-after removes the
adversarial pressure that produces cheating. Tests born agreeing with the
code leave nothing to cheat past; the evasion relocates into the suite's
epistemic value, which nothing measures. The harness's irreducible
contribution across every tier is the thing no output inspection recovers:
proof the tests preceded and constrained the code.

### Test quality: does blind test-first help? (mutation matrix)

Two mutants (rounding corruption, replay-guard removal) against six suites —
kill counts (tests failing):

| model | blind+harness | guidance |
|---|---|---|
| opus | 7 / 3 (89T) | 4 / 11 (395T) |
| sonnet | 1 / 4 (111T) | 1 / 5 (118T) |
| kimi | 2 / 2 (87T, r8) | 2 / 3 (253T, k27) · 3 / 4 (127T, k3) |

Every suite killed every mutant. Kill-power tracks the model, not the
methodology — even kimi's tests-after-code suites are non-tautological,
because the guidance prompt puts a rich spec in context. The tautology
disease (bare Runs 4/5) is test-after with the CODE as the only oracle, not
test-after per se.

Where blindness shows unique, replicated value, invisible to mutation:
precedence-ordering tests (3 in blind-opus, 0 in all five other suites —
including opus-guidance whose prompt demanded precedence explicitly; Run 6's
finding replicated); adversarial pressure that flushes defects during the run
(disputes, hatch-writing caught by gates); and evidence that exists without
post-hoc labor. Caveat: two mutants, one domain — a mutation-score gate would
make this a standing measurement.

### Gates validated live this day

green-requires-red (7-second self-correction on sonnet, day one), surface
check (first catch: sonnet builder's undeclared public), collection-time red
hint (25 min → 84 s on opus), size ceilings, test-source escape-hatch lint,
boundaries + reachability obligations, sign-off (kimi honestly confessing an
invalid red), deliver (every arm hand-off ready). Guidance-only arms were
run via `PI_CODING_AGENT_DIR=~/.pi-vanilla/agent` — a config dir holding only
auth/model symlinks, no extensions, no skills.

---
