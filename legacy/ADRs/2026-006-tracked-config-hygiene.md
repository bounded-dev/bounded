# 2026-006: Tracked config stays portable, pinned, and tool-agnostic

**Status:** accepted

## Decision

Three policies for everything tracked in this repo:

1. **Portable.** `settings.json` and extensions contain no machine-specific
   paths and no IDE/terminal-specific integrations. (A guarded loader for
   one desktop app's bundle was tried and removed when that app went away.)
   If a tool wants into the harness, it writes its own managed files rather
   than harness code reaching into an app bundle.
2. **Pinned.** Third-party packages in `settings.json` carry exact versions
   (`npm:pi-subagents@0.52.1`, `npm:betterwright@1.10.0`). Versioned specs
   are skipped by `pi update`, so "review source on update" is enforced
   rather than aspirational. Bump deliberately:
   `pi install npm:<pkg>@<version>`.
3. **Tool-managed files** (extension files an external tool installs under
   `extensions/`, gitignored by that tool's filename prefix) are
   **untracked** — runtime state, like `auth.json` and `sessions/`. The tool owns them
   end to end: it installs them, it rewrites them, and a fresh machine
   gets them from the tool, not the repo. Excluded from `npm run check`
   (untyped by design).

## Why

- Portability is the bootstrap story: tracked config must apply cleanly on
  any machine and OS without hand-edits.
- A harness that is live in every session wants reproducibility over
  freshness — an unpinned update previously took effect everywhere at once
  with no review gate.
- A tool owns its file paths; the harness never fights it over location.

## Consequences

- New-machine bootstrap needs no settings edits and no sibling-repo layout
  — third-party skills are vendored into `agent/skills/` (ADR 2026-012).
- `pi update --extensions` no longer moves npm packages; check for new
  versions periodically and bump by choice.
- No tool-rewrite noise diffs in history; the harness repo carries only what
  the harness authors. New-machine bootstrap is unchanged — each tool
  installs its own extensions on first launch.

## Change log

- 2026-08-24 — policy 3 changed from "tool-managed files stay tracked,
  commit rewrites promptly" to **untracked + gitignored** (approved by
  user). Tracking coupled the repo's history to a tool's output and
  created the commit-the-rewrites chore; the files are runtime state,
  not source. Recovery if ever needed: files remain in git history.
