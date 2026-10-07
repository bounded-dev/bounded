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
