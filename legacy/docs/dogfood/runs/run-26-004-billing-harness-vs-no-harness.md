# Run 4 — Sonnet · subscription-billing · A/B: harness vs. no harness · PLANNED
**Pre-registered before either arm runs.** The first test of whether the
machinery *adds* anything a good model doesn't already do. Runs 1–3 showed the
pipeline holds a weak model up; this asks the harder question.

- **Arms** (identical toolchain — vitest 4.1.11, TypeScript 5.9.3, the same
  strict `tsconfig.json` including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`):
  - **A · harness** — `~/dev/dogfood-billing-harness`, orchestrated through the
    `developer-stage` skill on Sonnet (orchestrator + all three workers).
  - **B · control** — `~/dev/dogfood-billing-control`, one Claude Code session
    on Sonnet, ordinary tools, no gates, no blindness, no skills.
- **Prompt: the same text, verbatim, to both.** Domain requirements plus one
  line of guidance ("Keep the code clean and well separated. Write it
  test-first."). Arm A's extra guidance comes only from the harness's own
  skills — which is precisely the variable. The exact text is committed at
  `docs/dogfood/subscription-billing-prompt.md` so the runs are reproducible.
- **Domain:** subscription billing with mid-period plan changes. Chosen for
  scope for error, not size: money + currency, dates and whole-day proration,
  rounding to the smallest unit, a capped charge, idempotency under a caller
  operation id, a rejected back-date, a cancelled-state machine, and a stated
  cross-cutting invariant (invoices summed == amount charged).

**What we measure** (fixed now; scored after both arms finish):

1. **Rule coverage** — for each of the prompt's numbered rules, does a test in
   that arm's suite actually pin it? Scored per rule, not in aggregate.
2. **Adversarial probes** — one probe suite per rule, written against each
   arm's own API *after* the runs, and run against both. Same scenarios both
   sides: proration cap not exceeded; rounding at the smallest unit; replayed
   operation id does not double-charge; back-dated operation rejected; cross-
   currency change rejected; change on a cancelled subscription rejected;
   invoices sum to charges after a change + renew sequence. This is the
   objective half — the arms' own suites grade themselves, the probes don't.
3. **Naked primitives at the boundary** — is money a `number`, a date a
   `string`, a currency a `string`? Direct evidence for #3, which all three
   earlier runs already implicate.
4. **Invariants in types vs. in prose** — non-empty collections, states that
   forbid operations, currency agreement: encoded or merely documented?
5. **Ports for side effects** — is time a `Clock` port or a `Date.now()` call?
6. **Type-clean** — does `npm run check` pass? Arm A's gates now enforce this
   (#7); arm B has nothing forcing it, which is the point.
7. **Did the tests grade their own exam?** — in arm B, were tests written
   before the implementation they cover, and do they assert behaviour or
   restate it?
8. **Cost** — turns and wall-clock per arm. The machinery has to be worth it.

**Result: the harness arm is the more robust artifact, and the margin is in
exactly the places the separation targets.** Both arms shipped working code —
arm A 49/49 green and type-clean, arm B 46/46 green and type-clean, neither a
false green. On behavioural probes they are near-identical (same proration
arithmetic, same invoice consistency, both reject back-dating, cross-currency,
and post-cancel operations). The differences are architectural.

**1. Value objects (measure 3) — decisive for arm A.** Arm A branded every
boundary type: `CurrencyCode`, `ISODate`, `MinorUnits`, `SubscriptionId`,
`PlanId`, `InvoiceId`, `OperationId`, `ArgsFingerprint`. Arm B shipped
`currency: string`, `Plan.id: string`, `operationId: string`, and — the worst
defect in either arm — `export type CalendarDate = Date`, a bare alias to a
mutable built-in whose "always UTC midnight" invariant exists only in a doc
comment. Probed: mutating a `Date` the caller still holds rewrites arm B's
stored billing period to `2030-03-01 → 2026-04-01`, a period ending before it
starts. Arm A cannot express that bug: an `ISODate` is an immutable string.
Both arms *do* leak the caller's `Plan` object by reference (both showed a
mutated price of 999999), so arm A is better here, not clean.

**2. Errors as values vs exceptions.** Arm A returns
`BillingResult<T> = {ok:true,value} | {ok:false,error}` over a closed
eight-member `BillingErrorCode` union — the type system forces every caller to
handle failure. Arm B throws nine error classes; nothing makes a caller catch
them. For a billing component this is the difference between a missed case
being a compile error and being a production incident.

**3. Pure state machine vs mutable object.** Arm A is `(state, args) →
BillingResult<Outcome>` with an explicit `BillingState` and a visible
idempotency `ledger`. Arm B is a mutable class with private fields and a
private `operations` Map. Arm A's shape gives replay, audit, and trivial
testing for free.

**4. Test quality — the clearest evidence for the separation (measure 7).**
Arm B's suite twice agreed with its own implementation rather than the prompt:
its cross-cutting invariant test is tautological (`totalCharged()` sums
`invoice.total`; the test asserts the sum equals `totalCharged()` — it cannot
fail), and a test named *"takes effect immediately in status"* directly
contradicts the prompt's "cancel takes effect at the end of the current
period". Arm A's test-writer, which never saw an implementation, produced
tests no implementer writes against themselves: *"a failed call does not
consume the operationId"*, *"a failed call leaves the ledger untouched"*,
*"start and renew must not share operationId namespace"*, *"a true replay
returns ok:true even when business rules would now fail"*, *"never charges
more than the new plan's full period price, across several remainingDays"*.
Two of those caught a real defect in the builder's first implementation — the
15-minute stall documented below is the loop working, expensively.

**5. Cost.** Arm B: 19.5 min, 20 tool calls, one session. Arm A: ~60 min, 62
orchestrator tool calls plus 8 worker spawns (architect ×3, test-writer ×3,
builder ×2), ~$1.35 in worker tokens, plus a 364-line `spec.md` arm B has no
equivalent of. Roughly 3× the wall clock for the better artifact.

**Caveats on this run.** (a) Arm A was contaminated mid-run: the
`no-naked-primitives` rule from issue #3 landed in the live checkout at
22:01 UTC and blocked arm A's contract at 22:10, costing one extra architect
round-trip. The rule was disabled for the remainder. Arm A's contract was
*already* fully branded before the rule fired, so the value-object verdict
above does not depend on the contamination — but it is not a clean result and
should not be cited as one. (b) Timing figures were measured on a machine at
load average 12 with two wedged `find /` processes; treat them as upper
bounds. (c) Both arms ran Sonnet; arm A's orchestrator spent its first two
minutes on Haiku before being switched.

**Verdict: the machinery earned its keep on this run, on quality, at ~3× the
cost.** The gap is not that the strong model *couldn't* produce arm A's design
— it plainly could — but that nothing in arm B made it, and nothing caught it
when it didn't.
