# 2026-005: Harness self-verification via `npm run check` + CI

**Status:** accepted

## Decision

The harness typechecks itself: `npm run check` runs `tsc --noEmit` over the
owned extensions (`extensions/`, excluding tool-managed files), backed by
`tsconfig.json`, pinned dev dependencies, a committed lockfile, and a GitHub
Actions workflow (`.github/workflows/check.yml`).

## Why

Every edit here is live immediately in every pi session on the machine
(`~/.pi/agent` symlink). A syntax or type error in `extensions/` previously
broke all projects at once with no gate. The first run of the check
immediately caught two latent type errors in `web.ts`.

## Consequences

- Run `npm run check` after editing any owned extension; CI enforces it on
  push/PR.
- `@earendil-works/pi-coding-agent` is a dev dependency pinned to the pi
  version in use — bump it deliberately when pi updates.
- Tool-managed extension files are excluded from the check; they are untyped
  by design (see 2026-006).
- A headless smoke test (`pi -p` exercising web_search and a subagent) after
  `pi update` remains a future addition.
