---
name: grill-me
description: A relentless interview to sharpen a plan or design, which also builds the project's domain model as you go — resolving terminology and updating CONTEXT.md glossaries and ADRs inline as decisions crystallise. Use when the user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

# Grill Me

Run two disciplines together, in one session:

1. [grilling](../grilling/SKILL.md) — the interview discipline: design tree, rounds, frontier questions with recommended answers.
2. [domain-modeling](../domain-modeling/SKILL.md) — the documentation discipline: sharpen terms, maintain `CONTEXT.md`, offer ADRs sparingly.

Resolve each path against this skill's directory and read both files fully before starting.

## How they interlock

- Grill and model **at the same time**. Every settled decision is also a chance to pin down the language it was expressed in; every fuzzy term the user uses is itself a frontier question ("you said 'account' — Customer or User?").
- The moment a term is resolved, write it to `CONTEXT.md` — inline, not batched. Exception: when this grilling is part of the expand → to-tn flow, keep a running note of resolved terms instead; `to-tn` writes them at synthesis time.
- The moment a decision meets all three ADR criteria (hard to reverse, surprising without context, real trade-off), offer the ADR.

## Cold-start repos are normal

The repo may have **no `CONTEXT.md` yet** — expect this, don't treat it as a blocker or ask permission to start one. The first term resolved with the user is the seed; create the file right there. Same for ADRs: create the ADR home only when the first ADR earns its place. If the repo already has its own glossary/ADR conventions, follow those instead of the defaults.
