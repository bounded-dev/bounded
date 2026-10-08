# LEG-2026-048: Team lead as the project entry

**Status:** accepted; how the lead starts an architect is superseded by
[LEG-2026-066](LEG-2026-066-lead-on-main-ticket-worktrees.md): each ticket's architect
runs as its own worktree's session, and the lead never commissions one.

## Decision

In a project-local installation, an ordinary main agent session is the team lead for every product request, including one ticket. The lead may inspect files inside the project, ask a read-only scout to investigate, and select a ticket and run boundary. It cannot edit product files or run arbitrary shell commands. A bound architect owns the ticket's design and the existing reviewer, test-writer, builder, and gate loop. The user's conversation stays with the lead.

The selected ticket is recorded per worktree under ignored `.bounded/` state. The lead uses an issue number where the project has a tracker and allocates a local ticket number otherwise. An explicit `BOUNDED_TICKET` remains available for existing direct launchers. Run preparation reads the terminal delivery result before opening a change boundary (ADR LEG-2026-053).

Host adapters may expose the handoff only when the host proves the architect's role and enforces its tools. Pi uses its per-agent loader. Claude Code uses an ordinary architect subagent with a bound definition hook; current Claude Code supports nested subagents, so that architect can commission the existing worker roles. Agent-team teammates are not used because their hook delivery and identity are not dependable enough for this boundary.

A dependency-free project entry handles a fresh clone before local packages exist. It permits only lockfile-backed setup and project-local reads, then activates the full adapter. If the full adapter fails to load, the entry keeps the session read-only. After the first run, it allows setup only as a repair, when a dependency tree it installed is missing (ADR LEG-2026-051).

A commissioned subagent in the project that no host can prove is bound to a role is held to the scout's read-only policy. If the full adapter fails to load, both hosts fall back to the same read-only-plus-setup policy.

## Why

The [project-local CRM dogfood run](../docs/dogfood/runs/run-26-030-project-local-crm-init.md), a demonstration project built under the harness, showed a top-level session doing change investigation outside any run or role guard. A single user-facing lead gives the user a natural entry and keeps product changes inside the architect's established checks. Team leadership is coordination, not a fifth pipeline writer.

## Consequences

The lead needs narrow run control and delegation tools. Project-local hooks fail closed for unbound change work. A host without a proven bound architect handoff must report that limitation instead of silently delegating unguarded work.
