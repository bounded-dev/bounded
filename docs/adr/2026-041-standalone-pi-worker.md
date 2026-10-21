# 2026-041: Run the Pi adapter through the standalone executable

**Status:** accepted. Amends [ADR 2026-033](2026-033-standalone-command-routing.md), [ADR 2026-037](2026-037-standalone-claude-code-hooks.md), and [ADR 2026-040](2026-040-standalone-project-check.md).

## Decision

Standalone `bounded init --host pi` writes a small project extension at `.pi/extensions/bounded/index.ts`. The extension uses Pi's own runtime to register its handlers and starts the project's pinned, verified Bounded executable with `hook pi --project <absolute-root>`. Bounded's compiled worker owns the adapter, project composition, shell reader, decision log and lifecycle checks. The consumer does not install Node, Bun, npm or a project package to run Bounded; Pi's own runtime remains Pi's responsibility. An exact generated loader from the older npm installation can be migrated. A different loader or intervening user edit is preserved and refused.

The bridge registers a blocking `tool_call` handler before starting its child. It sends bounded JSON lines over private pipes, validates event-specific requests and replies, bounds frames, aggregate queued bytes and response time, and drains stderr. It freezes the call input before waiting, sends only the context fields Bounded needs, and blocks if the worker, completion bus or protocol fails. The Pi host cannot be guarded if Pi itself refuses to register the extension's handler.

One compiled worker serves one Pi session. Each event captures a fresh verified release, managed pack graph, editor projection and complete reachable project source graph. A changed snapshot stops the session's cached composition before another third-party callback runs; a result must match its accepted call and snapshot. The bridge replaces and terminates the prior child on a new session or extension reload. The worker disposes its captured snapshot when the input stream closes.

`bounded check` verifies the exact generated Pi loader for Pi-only and combined Pi and Claude Code projects, then checks the same captured configuration and each installed host's port provisions without running lifecycle checks. Host installation prepares every requested host before writing, restores only successfully installed hosts, and attempts every safe rollback even if one edited host refuses restoration. The project version pin is written last.

The compiled archive test uses Pi 0.87.1's real extension loader. Native Windows execution remains part of the release gate.
