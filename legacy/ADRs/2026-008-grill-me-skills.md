# 2026-008: grill-me skills — grilling + domain modeling, ported from mattpocock/skills

**Status:** accepted

## Decision

Port Matt Pocock's grilling/domain-modeling skills (MIT) into `skills/` as
three skills:

- `grilling` — the interview discipline (design tree, rounds, frontier
  questions with recommended answers).
- `domain-modeling` — the documentation discipline (CONTEXT.md glossaries,
  sparing ADRs, lazy file creation).
- `grill-me` — composes both: grill relentlessly *while* resolving
  terminology into docs inline. This is the everyday entry point.

`skills/` scope widens from "harness-procedural" to harness-wide working
method (refines 2026-007). One harness addition over upstream: **repo
conventions win** — a project's existing glossary/ADR scheme overrides the
skill defaults. The harness dogfoods it via its own seeded `CONTEXT.md`.

## Why

- The same relentless-interview + ubiquitous-language loop benefits every
  repo; global skills give it to all of them at once.
- Upstream's split (grilling vs domain-modeling) is clean: each discipline
  triggers on its own description, `grill-me` composes by file reference
  (pi has no skill-calls-skill mechanism).
- Cold-start repos are the common case, so lazy creation is spelled out:
  the first resolved term seeds `CONTEXT.md`.

## Consequences

- `skills/` is no longer purely harness-procedural.
- Project `CONTEXT.md` files live in their projects, never here (global
  scope rule unchanged).
- Track upstream: mattpocock/skills evolves these skills regularly.
