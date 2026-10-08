# 2026-035: Harness state lives in `.bounded/`; every adapter lives in `hosts/<host>/` with its own install script

**Status:** accepted

## Decision

1. **Project state is the harness's, so it carries the harness's name.**
   Everything the developer stage keeps in a project — the guard log
   (`guard-log.jsonl` and its `guard-log-archive/`), the role binding
   (`dev-stage-role`), the model tiers (`dev-stage-models.json`), the frozen
   manifest (`contract-checksums.json`), the shadow project (`shadow-red/`),
   rendered screenshots — lives under **`.bounded/`**, not under any host's
   dot-directory. `.pi/settings.json` stays `.pi/` — that file is pi's, not
   ours.
2. **Every host adapter is one directory: `hosts/<host>/`.** The pi adapter
   moves from top-level `extensions/` to `hosts/pi/extensions/`, beside
   `hosts/claude-code/`; a future adapter is a new sibling. Top-level
   `extensions/` remains only as the tool-managed drop zone (ADR 2026-006),
   still on pi's extension path.
3. **Each adapter carries an `install` script** for its machine-level wiring
   (pi: the `~/.pi/agent` config-home symlink; Claude Code: the shared
   `~/.claude/CLAUDE.md` instruction file). `bounded init` walks
   `hosts/*/install` and runs them all — the core never knows a host's name.
   Per-project attachment stays per-adapter too (Claude Code's
   `install.ts <project>`).

## Why

- The state directory is read and written by every host; parking it under
  one host's name made a gates-only Claude Code run look pi-flavoured and
  the core look pi-owned.
- One directory per adapter is the isolation TN-26-007 promises: adding or
  deleting a host touches `hosts/<host>/` and nothing else.
- Install scripts per adapter keep `bounded init` a walker, not a registry —
  a new adapter wires itself by existing.

## Consequences

- Existing project trees carry `.pi/` state; a `bounded dogfood-reset` (or a
  fresh design run) recreates it as `.bounded/`. No migration shim — the
  arms are disposable and no delivered tree predates this.
- pi's global scan reaches the adapter through the loader shim
  `extensions/bounded/package.json` (see change log); the drop zone
  otherwise holds only tool-managed files.

## Change log

- 2026-09-22 — the layout as first shipped did not load: pi's global
  discovery scans `~/.pi/agent/extensions/` only (direct files, or a
  subdirectory whose own package.json declares `pi.extensions`) and never
  reads the agent dir's package.json. One dogfood arm ran fully ungated
  before this was caught. The drop zone now carries the loader shim
  `extensions/bounded/package.json` pointing at the adapter's real files,
  and `hosts/pi/discovery.test.ts` runs pi's own loader against the layout
  so discovery is pinned by test, not assumption.
