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
| [2026-005](2026-005-events-verdicts-dispatch.md) | Host-neutral events, verdicts and a pure dispatch (amended by 2026-025: an agent run's finish is an observation beside the events) |
| [2026-006](2026-006-effects.md) | A tool use is a list of precise effects (amended by 2026-019, 2026-020 and 2026-025) |
| [2026-007](2026-007-guards-over-a-composition.md) | Guards over a composition: the core pack and per-effect dispatch |
| [2026-008](2026-008-guard-log.md) | Every decision is recorded in the guard log, and an unrecorded decision fails closed (superseded by 2026-022) |
| [2026-009](2026-009-path-gate-pack.md) | The path gate is an ordinary pack shipped in `bounded`; deny-only rules (renamed `bounded/protected-paths` by 2026-021) |
| [2026-010](2026-010-project-configuration.md) | A project's configuration (defineConfig), and opening a project for judging |
| [2026-011](2026-011-drift.md) | Undoing what shell commands change in watched files |
| [2026-012](2026-012-value-objects-are-classes.md) | Value objects are classes, as in the example; a point takes a value object's wire form |
| [2026-013](2026-013-restructure.md) | The restructure: names that say what they hold, contracts everywhere, and rules that keep them (amended by 2026-025: the `onAgentRunFinish` point and `recordAgentRunFinish`) |
| [2026-014](2026-014-legacy-harness-moves-to-legacy.md) | The legacy harness moves to `legacy/`, both histories kept; its ADRs become `LEG-2026-NNN` |
| [2026-015](2026-015-host-installers.md) | Host installers are found by package export, outside pack composition: installing is distribution |
| [2026-016](2026-016-cli-app.md) | One package, `bounded`, carrying the CLI and the host adapters (separate apps in source), compiled for Node; installs and upgrades hand over to the installed version |
| [2026-017](2026-017-adapters-by-port.md) | Out adapters are grouped by the port they serve (`adapters/out/<port>/`), in-memory doubles are test support, and `Clock` and `DecisionIds` give value objects; two internal adapter export paths |
| [2026-018](2026-018-selection-brings-in-dependencies.md) | A selection brings in every pack its packs depend on, transitively; the project still contributes only to the packs it lists |
| [2026-019](2026-019-prereqs-pack.md) | The prerequisites pack, `bounded/prereqs`: an action needs a delegation that succeeded over unchanged files; amends 2026-006 (a delegate effect's `isolated` and `finishUnreported`, a tool result's `delegatedAgentRuns`); amended by 2026-025 |
| [2026-020](2026-020-shell-command-reading.md) | The core carries a shell command's reading on its execute effect, required, built by the host adapter with bounded's reader (`bounded-shell-command-reader`, published as `bounded/shell-command-reader`); the core checks its shape; the path gate judges from the reading (corrected in 3.3.0) |
| [2026-021](2026-021-protected-paths-rename.md) | The path gate is renamed the protected-paths pack, `bounded/protected-paths` and `protectedPathsPack`; a pack object takes the `Pack` suffix only where its bare name would clash with one of its point keys; 3.3.0 removes the old names |
| [2026-022](2026-022-bounded-log.md) | The guard log is the Bounded log, kept in `.bounded/log.jsonl`; an existing `.bounded/guard-log.jsonl` is left alone; supersedes 2026-008; amended by 2026-025 (the `agent-run-finished` event kind) |
| [2026-023](2026-023-legacy-harness-moves-out.md) | The original harness leaves `legacy/` for the private repository `bounded-dev/bounded-legacy`, with its own history; amends 2026-014 |
| [2026-024](2026-024-src-layout.md) | Everything the repository builds and ships lives under `src/`, and `src/` is the `bounded` package: the core in `src/core`, the shipped packs in `src/packs`, the shell command reader in `src/lib`, the hosts in `src/hosts`, the cli in `src/cli`, the repository's tests in `src/test`; amends the ADRs that state paths |
| [2026-025](2026-025-agent-run-finish.md) | A delegated agent run's finish is an observation (`AgentRunFinished`) the core hands to packs through `onAgentRunFinish`, recording only what they report; Claude Code's SubagentStop is mapped to it; `bounded/prereqs` counts a background run at its finish, and matches `require` exactly against the agent the host resolved; amends 2026-005, 2026-006, 2026-013, 2026-019 and 2026-022 |
