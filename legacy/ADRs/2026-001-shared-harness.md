# 2026-001: Shared personal harness

**Status:** accepted

## Decision

The pi harness is a standalone git repo at `~/dev/pi-harness`, symlinked to
`~/.pi/agent` (chosen over the `PI_CODING_AGENT_DIR` env var, which GUI
launchers may not inherit). Everything in it is **global scope**: it applies
identically to every project.

Two layers:

- **Personal** (preferences: status line, spinner, theme, model) — lives here,
  never travels.
- **Capability** (things a project could depend on, e.g. web search) — may live
  here for personal use, but if a project depends on one it must be published
  as a separately referenceable package (`npm:` or public `git:`) and declared
  in that project's committed `.pi/settings.json`.

## Why

- Identical harness for every project, installed once, no copying between
  projects.
- Projects remain usable by others: pi auto-installs packages a project
  declares on startup after trust. Litmus test: "stock pi + this repo — what
  breaks?" Whatever breaks belongs to the project, not the harness.

## Consequences

- `settings.json` here is the manifest for third-party packages
  (`pi install npm:<pkg>`).
- Secrets and session state stay untracked (see `.gitignore`).
