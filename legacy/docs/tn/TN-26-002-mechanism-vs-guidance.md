# TN-26-002: Mechanism vs guidance — the six-cell experiment

*2026-09-03/04. Evidence: archive branches `r10-*`…`r12-*`; narrative in
`docs/dogfooding.md` ("Runs 10–12"). Status: measured once, one domain, one
guidance volume — see Scope.*

## Question

The harness's founding claim is "enforce with mechanism, never with prose."
What does prose actually buy, per model tier, when it is as precise as the
mechanisms it mirrors?

## Design

One task (subscription billing), two conditions: the full harness, versus a
guidance prompt translating every gate one-to-one into prose
(`docs/dogfood/subscription-billing-guidance-prompt.md`) with zero
enforcement — run in a vanilla agent config (`PI_CODING_AGENT_DIR` pointed at
a directory containing only auth/model symlinks; no extensions, skills, or
gates). Models: opus 4.8, sonnet 5, kimi k2.7 and k3. Guidance arms were
graded post-hoc with the harness's own gates on scratch copies, plus manual
mutation probes (proration rounding corrupted; idempotent-replay guard
removed) and transcript inspection for test-first ordering.

## Results

Compliance with prose is a **capability gradient that fails silently at
whatever nothing re-checks**:

- **opus**: near-total compliance (one shed: precedence-ordering tests —
  demanded by the prompt, written into its spec, never tested). Its "red"
  was import failures: without generated skeletons a right-reason red is
  structurally impossible, so the audit trail cannot exist in guidance mode.
- **sonnet**: everything a linter could see was followed; the hostile-input
  requirement was skipped entirely and boundaries were under-quota (7/15) —
  neither confessed in its self-review.
- **kimi (both generations)**: statics followed; the test-first process
  abandoned outright (implementation before any test), structure conventions
  partially dropped, quotas underfilled, none confessed. k3 = k2.7 on
  process compliance: a model generation did not move the needle.

**Mutation matrix** (kill counts, rounding/idempotency): blind-harness suites
7/3 (opus), 1/4 (sonnet), 2/2 (kimi); guidance suites 4/11, 1/5, 2/3, 3/4.
Every suite killed every mutant. Kill-power tracks the model, not the
methodology — even tests written after code are non-tautological *when a
rich spec is in context* (the bare-arm tautologies of Runs 4/5 were
test-after with the code as the only oracle).

**The reframing finding**: kimi wrote zero hatches under guidance after 19
under the harness — not discipline, but the removal of adversarial pressure.
Tests born agreeing with the code leave nothing to cheat past; the evasion
relocates into the suite's epistemic value, which nothing measures.

**What blindness uniquely buys** (invisible to mutation testing): rejection-
precedence coverage (3 ordering tests in the blind suite, 0 in all five
others — replicating Run 6), in-run adversarial pressure that flushes
defects while they are cheap (disputes; hatch-writing caught at gates), and
evidence produced without post-hoc labor.

## Scope — do not over-extrapolate

The guidance prompt was ~15 rules: the thin generic layer, sized for any
frontier model's attention. The vision (docs/VISION.md) is hundreds of rules
across composed layers. Prose compliance already decayed within 15 rules
(opus 14/15, sonnet lower, kimi lower still) and rule *interactions* have
produced novel evasions at n≈10 (Run 9's optional-brand loophole). The open
measurement is the **compliance-vs-guidance-volume curve**: re-run the
guidance cells at 3–4× rule count and compare against the harness cells,
which should hold flat. Also note the instrument's provenance: a prompt this
precise is only writable *after* the gates discovered the rules — guidance
downstream of mechanism, not a substitute for it.
