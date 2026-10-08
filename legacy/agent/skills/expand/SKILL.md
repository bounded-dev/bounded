---
name: expand
description: Divergent exploration of a new idea, feature, or concept — research prior art, libraries, and parallel patterns from other domains, widen the requirement surface, and push back like an experienced product/architecture voice. Use when the user brings a new idea and wants to explore, research, or blue-sky it before tightening it down.
---

# Expand

The divergent phase: take a raw idea and widen what's *known* about it before anything gets tightened (`grill-me`) or written (`to-tn`).

**Write nothing.** Everything stays in the conversation. The TN, the CONTEXT.md updates, any ADRs — all of it lands later, at to-tn. No scratch files, no half-formed docs.

## Anchors

- The idea should sit on a planning ticket in the repo's issue tracker. If none exists, suggest creating one; don't block on it.
- Read the repo's `CONTEXT.md` / `CONTEXT-MAP.md` first if present — use its language, and challenge the idea against it.

## What to do

1. **Ground in the codebase.** Dispatch read-only subagents (`scout`) for facts about what already exists. Finding facts is your job, never the user's.
2. **Research outward.** Dispatch parallel research subagents for: existing libraries and tools, established techniques, and the same pattern used in *other* domains — parallels often carry the best insight. Prefer primary sources and keep citations; they feed the TN appendix later.
3. **Widen the requirement surface.** Adjacent use cases, edge cases, future pressures, implications the user hasn't stated. Blue-sky — but labelled as possibilities, never quietly promoted to commitments.
4. **Ask the PM.** Dispatch the `product-expert` subagent (skill: `product-expert`) with the raw idea and the facts gathered so far — early, and again on the widened requirement surface if it has shifted. Its value is independence: pushback from a context that wasn't part of this conversation. Fold its verdict into your synthesis.
5. **Push back yourself.** You are also an experienced product and architecture voice, not a cheerleader. Call out scope creep, YAGNI violations, poor architectural fit, and fuzzy problem statements — with reasons, and where possible a cheaper alternative. Expansion widens what's *known*, not what gets *built*.
6. **Synthesize in chat.** What exists, what's genuinely novel, which analogies matter, the widened requirement surface, your honest assessment of where the idea is strong and weak, and the open questions.

## Exit

Point at the next step: `grill-me` to tighten the design, or straight to `to-tn` to write it up.

