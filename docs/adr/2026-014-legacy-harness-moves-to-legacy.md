# 2026-014: The legacy harness moves to legacy/

**Status:** accepted. Amended by [ADR 2026-023](2026-023-legacy-harness-moves-out.md):
the original harness has left `legacy/` for its own private repository.

## Decision

- **This code becomes the Bounded harness, in the original public
  repository.** The repository that held the original harness (the `agent/`
  package published as `bounded`, its packs, skills, workflow tooling, ADRs
  and dogfood runs) adopts this code at its root. The original harness moves,
  unchanged in substance, into `legacy/`.
- **Both histories are kept.** The original harness's tracked files were
  moved into `legacy/` with `git mv` in one commit, and this repository's
  history was then merged in with `--allow-unrelated-histories --no-ff`. No
  history was rewritten: `git log --follow` reaches a legacy file's history
  from before the move, and this code's history from before the merge.
- **The legacy ADRs are renamed `LEG-2026-NNN`.** Both series numbered from
  `2026-001`. Every legacy ADR file became `legacy/ADRs/LEG-2026-NNN-slug.md`,
  and every reference to a legacy ADR number inside `legacy/` (comments,
  docs, ADRs, tests, JSON) was rewritten to match, in its own commit before
  the merge. So a search for `2026-NNN` finds only this series in
  `docs/adr/`, and a reference to a legacy decision says so: `LEG-2026-059`.
  Dates (`2026-10-07`) were left alone.
- **`legacy/` is read-only reference.** It is not built, linted, type-checked
  or tested, and nothing outside it imports it: the root workspaces are
  `contexts/*` and `apps/*`, `tsconfig.json` includes no path under it,
  Biome ignores it (`biome.json`), `bun test` ignores it (`bunfig.toml`),
  and the architecture and compile-time tests scan only `contexts/` and
  `apps/`. Its CI workflows moved with it to `legacy/.github/`, where GitHub
  does not run them. Agents and contributors do not edit it (AGENTS.md); a
  legacy idea worth keeping is rebuilt here through the lifecycle, with its
  own ADR that may cite the `LEG-` record.
- **The npm package `bounded` will be published from this code** as a new
  major version, superseding the legacy package's releases. That publish is
  a separate, later step; this decision does not make it.

## Why

The original repository is the public home of Bounded, with its issues,
history and package name. Moving the new code there, rather than archiving
the old repository and starting again, keeps one place to look and one
package name. Keeping the legacy tree whole, beside rather than deleted,
keeps its decisions and dogfood records readable where they were written.

## Consequences

- The root `README.md` points to `legacy/`; `legacy/README.md` opens with a
  read-only notice and where its ADRs, technical notes and dogfood runs are.
- The root `.gitignore` also ignores the per-checkout state the original
  harness ignored at the root (git worktrees under `.worktrees/`, Claude
  Code's `.claude/worktrees/` and local settings, and the runtime state an
  older checkout may still hold), so an existing checkout that moves to this
  layout does not suddenly show them as new files.
- `scripts/workflow/red-first-check.ts` walks this series' red commits as
  before: the merge adds `legacy/` beside them and changes none of their
  files.
