# Run 20 — re-confirmation, and a resume under an external limit
r20 re-ran the cockpit pair on the tree after the layer-move batch (ADR
2026-027 moved the cross-contract dual-identity refusal to a contract-purity
lint rule). The only functional change since r19 was that one rule, so the run
was a re-confirmation — does the clean r19 result hold, and does anything
regress — plus a chance to see the new rule in the wild.

| | kimi (k3 / k2.7) | anthropic (opus-5 / sonnet-5) |
|---|---|---|
| result | GREEN 199/199, delivered | GREEN 205/205, delivered (after a resume) |
| design | 5m46s (one review cycle, decomposed) | ~one review cycle (17 findings / 2 blockers) |
| total | **13m51s** | interrupted — see below |
| mutation | 95%, survivors confessed | 88%, survivors confessed |

**1. The clean result held; the new rule never needed to fire.** Both arms
delivered headless, passing their own `check`. `no-cross-contract-type-import`
did not block either arm — the decomposition steering kept both designs clean
enough that neither reached for a cross-contract type import. A rule earning
its keep by prevention, not catches, as in r19.

**2. Under twenty minutes, end to end.** kimi's 13m51s (design collapsed to
5m46s on a single review cycle) is the first time a run met issue #13's original
"under 20 minutes" target for the whole loop — the goal that looked unreachable
when design alone was 43 minutes at r18.

**3. A resume under an external limit — not a harness failure.** The anthropic
arm froze on one review cycle and reached 184/186 tests in build, then its
process died on an Anthropic account **usage-quota exhaustion** (`400 — out of
extra usage`), roughly two tests from green. After a top-up, `pi -c` resumed the
*same session* with its full context: it re-established a clean red (205, 0
passed), went green 205/205, ran mutation, signed off, and delivered. Because
the interruption spanned an overnight gap, its timing card is not comparable —
treat it as "resumed and delivered", not a clean measurement. The episode is
worth recording for the change cycle (TN-26-003): resume-from-disk after an
interruption worked, which is the same machinery harness-update recovery needs.

**4. A red-gate gap: passes against the skeleton.** kimi's valid red reported
`188 NotImplemented failures, 11 passed` — eleven tests green against the
all-skeleton shadow, i.e. tests that pass with *no implementation present*,
which are almost certainly tautological or structural. The red gate checks only
that every *failure* is a `NotImplementedError`; a test that *passes* against a
pure skeleton slips through. A candidate tightening: a valid red should arguably
carry no tests that pass against the skeleton. (The anthropic arm's re-red was
clean — 205 failures, 0 passed — so this is not universal.)
