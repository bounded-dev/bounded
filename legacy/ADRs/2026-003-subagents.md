# 2026-003: Subagents via pi-subagents, builtins disabled

**Status:** accepted

## Decision

Adopt `npm:pi-subagents` for subagent capability. Disable all bundled agents
via `"subagents": { "disableBuiltins": true }` in `settings.json`. Custom
agent definitions live as markdown in `agents/`, tracked in this repo.

The roster is deliberately minimal, with tool allowlists matched to role:

- **scout** — read-only (`read, grep, find, ls`) for parallel investigation;
  fans out freely, zero collision risk, reports with `path:line` evidence.
- **delegate** — write-capable worker (`read, grep, find, ls, bash, edit,
  write`) for one-off background tasks.
- **product-expert** ("the PM") — read-only + web (`read, grep, find, ls,
  web_search, web_fetch`) for independent product judgment during `expand`.
  Expertise lives in the `product-expert` skill (domain-instantiated per
  repo); the agent carries only permissions. Added 2026-07 for the
  expand → grill-me → to-tn flow (ADR 2026-009) — the first role to earn
  its place past the original pair.

All inherit the parent model until a second model tier is deliberately
adopted (cheap scouts, strong reviewers via per-agent model overrides).
Parallel write work uses worktree isolation rather than wider tool access.
New roles are added reluctantly, when a workflow actually needs them.

## Why

- The wanted part is the **runtime**: spawning child pi sessions,
  foreground/background runs, fleet observability, mid-run steering/intercom,
  spawn budgets and recursion guards, worktree isolation. Building that
  ourselves is expensive (unlike `web.ts`, ADR 2026-002).
- The unwanted part (the bundled roster) is thin markdown; disabling it is one
  settings line that travels with the harness.
- A "team lead" is just a custom agent with spawn rights; nothing extra needed.

## Consequences

- We depend on a third-party package with system access; pinned and reviewed
  on deliberate update (ADR 2026-006).
- Custom agents in `agents/` shadow builtins by name if ever re-enabled.
- Selective re-enable per agent: `subagent({ action: "enable", agent })` or
  `subagents.agentOverrides`.
