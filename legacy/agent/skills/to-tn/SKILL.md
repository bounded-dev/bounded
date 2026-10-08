---
name: to-tn
description: Turn the current conversation — expansion research, grilling, design discussion — into a Technical Note (TN) in the repo, landing resolved terminology in CONTEXT.md at the same time. Use when the user wants to write up, capture, or TN the current discussion into a durable technical document.
---

# To TN

Synthesize the conversation into a **Technical Note**: a technical document, not a transcript. The interview was the process; the TN is the synthesis. Q&A residue never becomes the body.

This is the step where the expand → grill-me flow's deferred writes happen: the TN file, the CONTEXT.md updates, any offered ADRs — all here, none earlier.

## Conventions

1. Read the repo's TN conventions first: `docs/tn/README.md`, `AGENTS.md`, existing `docs/tn/` files. **Repo conventions win** — numbering, front matter, kinds, statuses, index updates, reservation workflow, style rules.
2. A TN is born from a ticket. If the discussion isn't anchored to an issue yet, resolve that first. A legacy repo may explicitly allow a `TBD` convention; a ticket-numbered repo does not.
   In a ticket-numbered project, verify the issue exists in that repository before creating `TN-<issue-number>.md`; a bare number in front matter does not establish that the ticket exists.
3. No TN system in the repo? Use `docs/tn/TN-<issue-number>.md` and a short `docs/tn/README.md`, created alongside the first note. One issue may have one evolving TN; issues without useful design thinking need none. Do not reserve TN numbers. Record `issue` and `status` in front matter, and list `contracts` when the note owns a design handoff. Existing repo conventions still win.

## Shape

Front matter per convention, then:

- **Summary** — what this is, why, and the recommendation. Readable standalone by someone who wasn't in the conversation.
- **Sections** — one per major design branch of the discussion. Each explains how that part works, in compact prose and bullets, self-sufficient, ordered by dependency.
- **Decisions** — the settled calls, each with its *why* (the trade-off). Any decision meeting all three ADR criteria (hard to reverse, surprising without context, real trade-off) gets offered as an ADR — sparingly, per [domain-modeling](../domain-modeling/SKILL.md).
- **Open questions** — anything deliberately left unresolved, with what would resolve it.
- **Appendix** — research findings with citations, alternatives considered, Q&A residue.

Style: compact, bulleted, one sentence per bullet where possible. The repo's own TN style rules override this when they exist.

## Land the language

Terms resolved during the session go into the repo's `CONTEXT.md` now — format per [CONTEXT-FORMAT.md](../domain-modeling/CONTEXT-FORMAT.md), created lazily if absent, placed in the owning context if there's a `CONTEXT-MAP.md`.

## Before showing the user

Self-review, and fix before presenting:

- No placeholders, no contradictions
- No ambiguity presented as settled
- Scope matches the ticket — nothing silently added or dropped
- Every research claim still carries its source

Then present for review. The note stays `status: draft` until the user promotes it (or per repo convention).
