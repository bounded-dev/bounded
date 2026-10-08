# 2026-014: Agent guidance is structure and procedure, never persona

**Status:** accepted

## Decision

Agent definitions carry **role separation**, **scoped access**, and
**procedural instruction** (checklists, enumeration walks, stop rules). They do
not carry **character prose** — biography, years of experience, professional
pride, personality framing.

Concretely: "walk these seven axes and add no test that cannot fail alone" is
in scope. "You are a meticulous engineer with two decades of experience who
takes pride in finding the edge case nobody considered" is not.

## Why

**The external evidence is a replicated negative.** [When "A Helpful Assistant"
Is Not Really Helpful](https://arxiv.org/abs/2311.10054) (EMNLP Findings 2024)
tested personas in system prompts across four model families and 2,410
questions: no improvement over a no-persona control, and often a small negative
effect. Measured accuracy varied with the persona's *gender and domain* — noise,
not signal. [Principled Personas](https://arxiv.org/pdf/2508.19764) found expert
personas sometimes helped and sometimes harmed, while irrelevant attributes
(names, colours, and by extension biographies) *frequently degraded*
performance.

**What the literature does support is the thing we already rely on.** The
multi-agent software-engineering work (MetaGPT, ChatDev and that lineage,
surveyed in [arXiv:2404.04834](https://arxiv.org/pdf/2404.04834)) finds that
role-based division of labour — separate agents, separate contexts, scoped
authority — improves outcomes. That is a decomposition effect, not a
personality effect. ADR 2026-013 already rests on it, and our own runs confirm
it: two bare arms independently wrote a tautological invariant test that cannot
fail; neither blind arm did.

**Our own runs separate the two cleanly.** Between two dogfood runs on the same
model, domain and prompt, the test-writer gained both a character section and a
procedural enumeration method. Like-for-like on the comparable subset the suite
went 49 → 58 tests, and the one axis the method names explicitly — *which error
wins when several checks would all fail* — went from **0 tests to 2**. That is
the procedure's fingerprint, not a general uplift.

The architect's guidance, which is judgemental rather than procedural ("find the
simple shape", "prefer depth", "do not over-abstract"), was followed by one
model and **ignored entirely** by another: given identical instructions, Kimi
K2.7 declared five ports over pure arithmetic and exposed a single factory
function, costing 262 lines of fake setup before a test could run. Design
quality tracked the model, not the words.

This matches the task-structure finding in the 2026 persona work: in well-defined
generation tasks personas shape strategy, while in open-ended tasks
architectural limits dominate. Procedure survives a model change; taste does not.

## Consequences

- Design quality cannot be bought with better-written architect prose. If we
  want it, it has to come from a mechanism — a review step, a deterministic
  check, or a stronger model in that seat. This is the main open question in
  the strip-down.
- Removing character prose from an agent definition is not a regression and
  should not be re-added without evidence that it changes outputs.
- Procedural guidance remains fair game and should be written as a checklist
  with an explicit stop condition, so it is testable by looking for its
  fingerprint in the output.

## Caveat

The flagship persona study measures factual QA, not agentic coding, so it is
suggestive rather than decisive here. It is a large replicated negative result
that agrees with what we observed across two model families, which is enough to
stop investing in character prose — not enough to claim it can never help.
