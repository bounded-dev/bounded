# 2026-037: The standalone executable installs Claude Code hooks

**Status:** accepted for the Claude Code host slice of issue #67. Amends
[ADR 2026-033](2026-033-standalone-command-routing.md). The published Node
CLI and its hook installer remain available for npm projects.

## Context

The compiled release could run `hook claude-code`, but `init` still refused
Claude Code because it had no executable-carried installer. The published
installer wrote a Node command into project settings. A standalone project
can have no `package.json`, Node, Bun or npm.

## Decision

- `bounded init --host claude-code` uses its executable's adjacent release
  identity, then installs a command naming that executable and
  `hook claude-code`. The command gives the project root from
  `CLAUDE_PROJECT_DIR`; it requires no project package or runtime.
- PreToolUse, PostToolUse and PostToolUseFailure commands refuse with exit 2
  if the executable cannot start. SubagentStop runs the bare command because
  exit 2 there can prevent the subagent from stopping.
- The installer replaces recognized older Bounded hooks in all four events.
  It keeps unrelated settings, role hooks and lookalikes. It stages the new
  JSON beside settings and atomically replaces the file while retaining its
  permissions. The host command has a POSIX shell form and a PowerShell form;
  native Windows release testing is the gate for the latter.
- Setup installs the hook before creating the configuration, so a call during
  setup is refused until the configuration is ready. The project version pin
  is written last. If setup fails, it restores the previous settings and
  removes only the configuration it created. A crash can leave the new hook
  active without a pin, in which case it still fails closed or uses the
  current executable.
- This slice verifies the adjacent release identity's shape and version and
  tests an archive after manifest verification. It does not rehash the
  current same-version executable on each hook call; the installed-release
  locator verifies other pinned versions separately.

## Consequences

A Python project can initialize and run Claude Code hooks from a verified
standalone archive with no package-manager commands. `init` remains
write-once. Pi, update, check and the other distribution commands retain
their explicit refusals until their host slices land.
