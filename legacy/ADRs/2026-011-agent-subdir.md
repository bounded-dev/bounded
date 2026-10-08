# 2026-011: pi config home moves to `agent/` subdirectory

**Status:** accepted

## Decision

The repo root is no longer the pi config home. Everything pi-facing moves into
`agent/`, and `~/.pi/agent` is repointed:

```
~/.pi/agent → ~/dev/pi-harness/agent   (was → ~/dev/pi-harness)
```

- **`agent/`** (= `~/.pi/agent`, global, every project): its own `AGENTS.md`
  (the global default), `settings.json`, `extensions/`, `agents/`, `skills/`,
  `packs/`, the self-check tooling (`package.json`/`package-lock.json`/
  `tsconfig.json`), and all gitignored state (`sessions/`, `auth.json`,
  `models-store.json`, `npm/`, `bin/`, `node_modules/`, `missions/`,
  `run-history.jsonl`).
- **Repo root** (project-level, loaded only when working on the harness):
  root `AGENTS.md` (harness-maintenance rules), `README.md`, `ADRs/`,
  `CONTEXT.md`, `.github/`, `.gitignore`.

Path fixes forced by the extra level:

1. CI (`.github/workflows/check.yml`): `run` steps use
   `working-directory: agent`; npm cache keyed on `agent/package-lock.json`.
2. Bootstrap symlink target becomes `pi-harness/agent`.

The `../bounded-dev/skills` package pointer did **not** survive the move: pi
resolves local package paths lexically against the `~/.pi/agent` symlink (via
`path.resolve`, which collapses `..` textually and never follows the symlink),
not against the repo's real path. No relative pointer to a sister repo can be
both correct under that resolution and layout-independent, so the skill was
vendored into `agent/skills/` instead (ADR 2026-012).

## Why

Because the root was `~/.pi/agent`, the root `AGENTS.md` did double duty: it
was **both** the global default injected into every session in every project
**and** the harness-maintenance project instructions. That leaked ADR duty,
`pi install` rules, and "never commit secrets" into unrelated game/accounting
sessions, and duplicated the harness rules in-context.

A subdirectory boundary dissolves it: root = the harness *project*, `agent/` =
the pi config *home*. One symlink repoint, no file doing double duty — cleaner
than an equivalent per-file symlink farm.

## Consequences

- A new `agent/AGENTS.md` is the global default (seeded as a stub, to be
  written deliberately). The root `AGENTS.md` stays as harness-project rules.
- The restructure was executed by a session that died mid-flight (fireworks
  model), leaving the symlink unswapped while config had already moved — which
  broke model access for subsequent sessions until the swap was completed.
- Bootstrap: `ln -s "$PWD/pi-harness/agent" ~/.pi/agent`; run `npm ci` /
  `npm run check` from `agent/`.
