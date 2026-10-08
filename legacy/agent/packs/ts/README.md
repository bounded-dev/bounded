# packs/ts — TypeScript/React language pack

Everything TypeScript-specific in the harness lives here (ADR LEG-2026-007).
Loaded globally via the root `settings.json` (`"./packs/ts"`), but scoped by
form: skills are on-demand, so presence in a non-TS session costs nothing.

## What belongs where

| Kind | Lives here? | Notes |
| ---- | ----------- | ----- |
| Procedural skills (new TS service, release, db migration, …) | **yes** — `skills/` | Agent-facing glue; point at scaffolders, don't duplicate them |
| Scaffolders and emitters (the domain emitter, …) | **yes** — `scripts/` | Deterministic shape is *generated*, not remembered |
| Shared lint/architecture rules (hexagonal boundaries, …) | template, vendored | Projects own their copy and may drift; update the template as the source of truth |
| Project template (committed `.pi/settings.json`, AGENTS.md, canonical commands) | template repo | ADR LEG-2026-007 — the vehicle projects are created from |
| Anything language-agnostic | **no** — harness root | Root stays portable and stock-pi compatible |

## Layering: activation scope, not taxonomy (ADR LEG-2026-007)

Packs stay flat (`packs/ts`, later maybe `packs/ts-react`) — no
language/framework/app-type directory tree. Skill names carry the domain
prefix (`ts-new-value-object`). Where a piece of knowledge lives is decided
by *when it should fire*:

- **Always-on app-type constraints** → vendored into the project's
  `AGENTS.md` + lint config from the template (not loaded globally).
- **Task-scoped procedures** → description-triggered skills here.
- **File-scoped rules** → lint / architecture tests (pi has no glob
  triggers; deterministic is better anyway).
- **Heavyweight playbooks** → manual `/skill:name`
  (`disable-model-invocation: true`).

Skills are self-contained: never reference across packs with
`../../<pack>/` paths — duplicate the lines instead.

## Rules as code, not prose

Architecture rules (hexagonal layering, validated routes, value-object
primitives) should be enforced by eslint/dependency-cruiser/tsconfig and
produced by scaffolders. Prose conventions are for intent and exceptions —
agents follow code always and prose mostly.

## Split trigger

When a second language pack exists and this pack is stable, or it needs
independent versioning/sharing: move this directory to its own repo and
change one line in the root `settings.json` (path or `git:` package). The
package seam makes the split mechanical.
