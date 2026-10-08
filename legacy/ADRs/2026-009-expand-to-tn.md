# 2026-009: expand + to-tn — the idea-to-TN flow

**Status:** accepted

## Decision

Two more working-method skills in `skills/`:

- `expand` — divergent phase: research (prior art, libraries, cross-domain
  parallels), widened requirement surface, and first-class **pushback**
  (YAGNI, scope creep, poor architecture) from an experienced
  product/architecture voice. Writes nothing.
- `to-tn` — synthesis: turns the conversation into a Technical Note
  (summary → sections → decisions → open questions → appendix), lands
  resolved terms in `CONTEXT.md`, offers ADRs sparingly.

Flow: **expand → grill-me → to-tn**. Steps 1–2 write no files; everything
lands at to-tn. This deliberately deviates from upstream domain-modeling's
inline-update rule (noted in both affected skills). Ticket decomposition
(`tn-decompose`) is parked, not rejected. The product-review persona landed
as the `product-expert` roster agent (ADR 2026-003); an architect reviewer
remains parked. TN conventions stay per-repo
(`docs/tn/README.md`); skills follow "repo conventions win", matching
ADR 2026-008.

## Why

- The TN system (per-repo; see bounded.dev "Write It Down, Sort It Later")
  is the storage layer; these skills are the process layer on top.
- Deferring writes avoids half-formed docs and Q&A-shaped notes: the TN is
  written once, as synthesis, not accumulated as transcript.

## Consequences

- `grill-me` and `domain-modeling` carry flow-aware deferral exceptions.
- Repos without a TN system get one lazily via the default in `to-tn`.

## Change log

- 2026-08-21 — removed the "heavyweight phase-gated pipelines fail; small
  description-triggered skills compose" bullet from **Why** (approved by
  user). It was being read as a general caution against gated multi-stage
  pipelines, conflicting with the determinism-over-minimalism principle
  (AGENTS.md) behind the developer-stage pipeline work (architect /
  test-writer / developer with deterministic enforcement layers). The
  original research observation about *skill composition* vs monolithic
  phase gates still stands as orchestration guidance; it is not a verdict
  on enforcement depth.
