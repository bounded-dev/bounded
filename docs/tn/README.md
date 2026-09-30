# Technical Notes

Project thinking lives here as numbered Technical Notes (TNs) — one file per
note, born from a GitHub issue.

## Scheme

- One file per note: `TN-YY-NNN-slug.md` — `YY` year, `NNN` incrementing
  within the year, slug kebab-case.
- Front matter: `number`, `title`, `kind` (`design` | `process` | `research`),
  `status` (`draft` | `active` | `ratified` | `superseded`), `issue` (GitHub
  issue number).
- Written once, as synthesis — never accumulated as transcript (ADR 2026-009).
- Terms resolved in a TN land in the root `CONTEXT.md`; hard-to-reverse
  decisions may be promoted to ADRs.

## Index

| TN | Title | Status |
| --- | --- | --- |
| [TN-26-001](TN-26-001-developer-stage-pipeline.md) | Developer stage: architect / test-writer / builder pipeline | draft |
| [TN-26-002](TN-26-002-mechanism-vs-guidance.md) | Mechanism vs guidance: the six-cell experiment | draft |
| [TN-26-003](TN-26-003-change-cycle.md) | The change cycle — evolving a delivered component | draft |
| [TN-26-004](TN-26-004-api-service-reference-set.md) | The API-service reference set — one deterministic way onto the wire | draft |
| [TN-26-005](TN-26-005-pack-composition.md) | Pack composition — sockets in the core, contributions from packs | draft |
| [TN-26-006](TN-26-006-web-frontend-reference-set.md) | The web-frontend reference set — FSD layers, shadcn, typed client | draft |
| [TN-26-007](TN-26-007-agent-agnostic-harness.md) | The agent-agnostic harness — one deterministic CLI, any agent framework | draft |
| [TN-26-008](TN-26-008-gate-verified-reference-components.md) | Gate-verified reference components — what "good" looks like, as code the agent copies | draft |
| [TN-26-009](TN-26-009-composition-is-a-commitment.md) | Composition is a commitment — each pack obligates its own layer | draft |
| [TN-26-011](TN-26-011-dependent-ticket-handoffs.md) | Dependent tickets: frozen design as a handoff | draft |
| [TN-26-012](TN-26-012-hexagonal-monorepo-conventions.md) | Hexagonal monorepo conventions — the names, shapes and files every generator agrees on | active |
