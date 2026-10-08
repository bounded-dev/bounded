# Architecture decision records

One file per decision, `YYYY-NNN-slug.md`, numbered in order of acceptance.
Each is short: the decision, why, and its consequences. Rewrite freely while a
decision is young; supersede it with a new record once code depends on it.

| ADR | Decision |
| --- | --- |
| [2026-001](2026-001-development-lifecycle.md) | A development lifecycle: plan, plan review, red commit, build, final review |
| [2026-002](2026-002-typed-extension-points.md) | Typed extension points with compile-time ownership; deviations from the example |
| [2026-003](2026-003-packs-refer-to-packs.md) | Packs refer to each other as objects; strict typing is binding |
| [2026-004](2026-004-namespaced-pack-ids.md) | npm-namespaced pack ids; selection by pack objects; workspace package `bounded` |
| [2026-005](2026-005-events-verdicts-dispatch.md) | Host-neutral events, verdicts and a pure dispatch |
| [2026-006](2026-006-effects.md) | A tool use is a list of precise effects |
| [2026-007](2026-007-guards-over-a-composition.md) | Guards over a composition: the core pack and per-effect dispatch |
| [2026-008](2026-008-guard-log.md) | Every decision is recorded in the guard log, and an unrecorded decision fails closed |
| [2026-009](2026-009-path-gate-pack.md) | The path gate is an ordinary pack shipped in `bounded`; deny-only rules |
| [2026-010](2026-010-project-configuration.md) | A project's configuration (defineConfig), and opening a project for judging |
| [2026-011](2026-011-drift.md) | Undoing what shell commands change in watched files |
| [2026-012](2026-012-value-objects-are-classes.md) | Value objects are classes, as in the example; a point takes a value object's wire form |
