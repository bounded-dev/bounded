# Run 6 — Sonnet · subscription-billing · bare vs FOLDED harness · PLANNED
Pre-registered before either arm runs. **The question is narrow on purpose:
did folding the orchestrator and the architect into one role (issue #12) cost
any quality, and did it buy back any of the time?** Run 5's harness arm is the
yardstick for quality; Run 5's bare arm is the yardstick for whether the
separation still pays at all.

Same baseline as Run 5, same prompt byte-for-byte
(`docs/dogfood/subscription-billing-prompt.md`), same toolchain (vitest 4.1.11,
TypeScript 5.9.3), **Sonnet throughout**. Both arms are built by
`dogfood-reset`, which verifies the prompt and the operational block are
byte-identical and fails if they are not; one line differs, naming what the
environment offers.

- **1 · bare** — `~/dev/pi-harness-dogfood-bare`. **Claude
  Code**, one agent, ordinary tools, no skills — same as Run 5's arm 1, so the
  control is comparable across runs. *"Nothing special. Build it with your
  ordinary tools, the way you think it should be built."*
- **2 · folded** — `~/dev/pi-harness-dogfood-harnessed`. **pi**, gated as the
  architect through the project's `.pi/dev-stage-role`. *"This project is built
  through the `developer-stage` skill. Invoke it and follow it."*

The two arms therefore run on different agent harnesses (Claude Code vs pi),
as they did in Runs 4 and 5. That is a confound the comparison has always
carried and it is worth restating: the bare arm is not "pi without the
pipeline", it is a different tool. What survives it is the *test-quality*
finding, which is about who writes the tests rather than which harness runs.

**What changed in the harness since Run 5.** The architect now owns the ticket
end to end — designs it, commissions the test-writer and builder, runs every
gate, arbitrates. There is no separate orchestrator and no PLAN phase. It reads
everything and writes only `spec.md` and `*.contract.ts`. It has no `bash`: six
gate tools plus `git`, and `--exclude-tools bash` so the tool is not even
visible to reach for. `.pi/` became write-denied to every role.

**Predictions, recorded now so they can be wrong.**

1. **Quality holds.** Test count in the 80–110 band (Run 5: 95), the ordering
   tests still present, and no tautological invariant test. If the folded arm
   drops toward the bare arm's 31, the separate architect was doing something
   we did not measure.
2. **Cost falls.** One fewer subagent spawn, no plan document, and no
   gate-invocation archaeology (Run 4 lost ~3 minutes to it; the tool schemas
   now carry the invocations). Expect under Run 5's ~33 minutes and under its
   $2.44, though stalls dominate the wall clock and could swamp the saving.
3. **The bare arm writes a tautological invariant test again.** It has done so
   twice, on two different days. A third would make it the most replicated
   finding in this file.

**The specific risk this run is watching: laundered blindness.** The architect
can now read `tests/`, which it could not before. It writes the spec *before*
any test exists, so the first pass is safe — but on a dispute or revision pass
it may read a test and then revise the spec, and the builder reads the spec.
That is a path for test detail to reach the builder without either of them
breaking a rule. **Check every spec revision that happens after the red gate
against the tests that existed at that moment.** If specifics leak, the fix is
a narrower rule (no spec edits after red without a logged rationale), not a
retreat from the fold.

**Second watch item: does it stay in its lane?** The path gate logs every
refused write. A folded architect that repeatedly tries to edit `tests/` or
`src/` is telling us the role is uncomfortable, even if the gate holds. Read
`.pi/guard-log.jsonl` for `path-gate` blocks and count them by target.

**Scored on Run 4's criteria, unchanged:** per-rule coverage, adversarial
probes run against both arms, naked primitives at the boundary, invariants in
types vs prose, ports vs ambient time, `npm run check`, whether the tests
graded their own exam, and cost.

**Pre-flight, run before registering this.** The gated session starts, blocks a
write to `tests/probe.test.ts` with the expected message, writes that block to
the guard log, and — after a fix this pre-flight prompted — no longer sees
`bash` at all. Run 5 lost two attempts to void runs; this is the cheap
insurance against a third.

**Hygiene.** **Do not push to pi-harness main while arm 2 runs** — it resolves gates through
`~/.pi/agent` → the live checkout, which is how Run 4's harness arm got
contaminated mid-flight.

**Result: reached green, on the third attempt.** 83/83 tests passing,
`npm run check` clean, contracts unchanged from the freeze. The first two
attempts were voided before scoring: one by the session defaulting to
`kimi-k2p7-code` instead of Sonnet, the other by the YAML skill bug recorded
below, which silently dropped `developer-stage` from every session's skill
list. What follows compares the two completed arms — same prompt,
byte-for-byte, both Sonnet.

| | bare (Claude Code) | harnessed (pi) |
|---|---|---|
| tests / files | 53 / 3 | 83 / 11 |
| src modules | 6 | 7 |
| contract files | 0 | 7 |
| exported functions | 18 | 25 |
| wall clock | 12.1 min | 30.5 min |
| assistant turns | 27 | 62 |
| tool calls | 16 | 67 |
| tokens, total | ~2.2M | ~6.9M |
| tokens, output / cache read | 292k / 1.64M | 148k / 6.1M |
| cost | not captured | ~$3.65 |

Every finding below is a mechanism rather than a matter of taste.

**1. The tautology did not reproduce, and that weakens the headline finding.**
Runs 4 and 5 both had the bare arm write a self-confirming invariant test — sum
the invoices, assert the sum equals itself under another name. This time it
did not: the bare arm's `totalCharged()` helper is summed in the test and
asserted against hand-derived literals (1000, 2000, 1000+1000+…+3000), inside a
proper `describe("invariant: invoices sum to the total actually charged")`.
The headline evidence for the separation is now **2 of 3, not 3 of 3**. Stated
plainly, because it should be — the case is weaker than Run 5 left it.

**2. The "one contract" wording fix still shows a large effect.** Guidance
changed between attempts from "a `spec.md` and one component contract" to "as
many `*.contract.ts` files as the design needs". Same prompt, same model, same
day:

| attempt | contract files | shape |
|---|---|---|
| before the fix | 1 | one `SubscriptionBilling` interface, 4 methods, unimplementable |
| after the fix | **7** | `calendar` `ids` `invoice` `money` `plan` `result` `subscription`, 38 operations |

Two data points only, but they point the same direction as ADR 2026-014: fix
what is *wrong*, do not add more taste.

**3. Value objects reproduced for a third consecutive run.** Bare:
`currency: string`, `amount: number`, `id: string`; only `CalendarDate`
branded. Harnessed: `Currency`, `MinorUnits`, `CustomerId`, `PlanId`,
`SubscriptionId`, `OperationId`, `InvoiceId` — all branded, all with smart
constructors.

**4. Error modelling converged — unexpected.** Both arms used result types
(`ok`/`err` discriminated unions), not exceptions. Runs 4 and 5 both had the
bare arm throw nine error classes; this time it didn't. Both arms also avoided
Run 4's catastrophic `CalendarDate = Date` aliasing bug — the bare arm used a
branded string instead. On this axis the arms are no longer distinguishable,
which the earlier runs gave no reason to expect.

**5. The spec's unique contribution is execution order, confirmed a second
way.** The harnessed arm wrote all 83 tests with no `spec.md` — the architect
skipped it, four attempts out of four. What survived without one: replay and
idempotency tests, including *"replaying an operationId ignores changed
arguments"*; arithmetic pinned to hand-derived literals, including the 2024
leap year found unprompted (`daysBetween` returns 29, against 28 in 2023); and
a non-tautological invariant walking start → renew → changePlan → renew →
cancel with running totals annotated by hand. What was absent: **zero**
precondition-ordering tests — which error wins when several checks would all
fail. Run 5's harnessed arm had two. Blindness alone prevents the tautology;
only the spec gets you ordering.

**6. The `run_tests` nudge detects non-convergence but does not reliably
produce a dispute.** It fired five times across eleven `run_tests` calls. The
builder kept implementing and exited with an empty verdict, never disputing.
Runs 4 and 5 both recorded "progress on the very next run" after the nudge
fired, which read as the mechanism working — this is the first run where it
fired and was ignored outright.

**7. A failing test routes to the builder unconditionally, and this time it
deadlocked — then the architect broke its own rule to escape.** The final
failure was a test bug: after `start → renew → changePlan` there are three
invoices, and the test read `invoices[1]` (the renewal) instead of
`invoices[2]` (the proration), having copied the index from a sibling test with
no renewal step. The green gate routed to the builder by rule; the architect
obeyed, as the skill instructs ("do not improvise a target"); the builder
cannot see tests, so it respawned and hit the identical failure a second time.
The architect then overrode the route itself, diagnosed the test as wrong, and
commissioned a test-writer, which fixed `invoices[1]` → `[2]`. That is
*contrary* to the skill's explicit instruction. It worked, and it cost two
builder spawns and roughly 15 minutes to get there.

**8. Respawns dominated cost.** Five workers stood in for three roles, and
every bounce was a cold respawn re-priming a full context. Cache reads per
spawn: builder #1 1.75M, test-writer 649k, test-writer 603k, builder #2 362k —
roughly 1.6M tokens, about a quarter of the run's total, spent re-teaching
agents what a sibling agent already knew. pi supports retained children
(`children.list` / `resume`); issue #11 proposed this and was closed as "worth
only 1–2 minutes per run." This run's numbers say otherwise.

**9. A launched architect holds more than a spawned one.** Its tool tally
included `bash` (3 calls, all refused by the path gate) and `run_tests`. The
frontmatter allowlist binds subagents only, so a session started from
`.pi/dev-stage-role` gets everything pi offers minus what the path gate blocks.
*(Closed since, after r14 paid for it again: a bound session now has its
forbidden tools removed from the visible toolset at `session_start` — logged as
a `tool-strip` guard event — and `bounded ticket` additionally launches with
`--exclude-tools`, which drops them from the registry outright. A refusal layer
stays as a backstop.)*

**Harness bugs found and fixed during the run** (each one voided an attempt or
a gate result): a `: ` inside the skill's unquoted YAML description silently
removed `developer-stage` from every session's skill list; the ambient path
gate applied the parent's role to every child, so the test-writer was refused
permission to write its own tests as "architect"; `contract-purity`,
`typecheck` and `checksum-gate` all passed a contract with zero value exports
(every operation was a method on an exported interface, which vanishes at
compile time); zone globs were case-sensitive on a case-insensitive
filesystem, which refused `SPEC.md` and would have let `TESTS/x.test.ts` walk
through the blindness; and `contract-purity` passed `export function f(): T;`
with no `declare` — a silent TS2391 that only surfaced later as 25 `tsc`
errors.

**Queued from this run:** reopen issue #11 (retained children) against finding
8's numbers rather than the earlier estimate; decide whether the architect's
rule-breaking override in finding 7 should become a codified escape hatch — it
worked, but it worked by an agent doing the thing it was explicitly told not to
do; and a compile check inside `contract-purity` so the zero-value-export class
of bug is caught before the checksum gate, not after.
