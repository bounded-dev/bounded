# 2026-069: Claude Code's session tools, and a seat re-reading its own saved output

**Status:** accepted. Amends 2026-034, 2026-048 and 2026-066.

## Context

In the 2026-10-02/03 dogfood run (#47), the scout's `SubagentHandback` was
refused six times and both scout reports were lost. The lead could not load a
deferred tool with `ToolSearch`. Seats could not read the file Claude Code
saves a too-large tool result to, because that file is outside the project.

## Decision

- **Session tools.** `SubagentHandback` and `ToolSearch` act on the
  conversation, never on the project or the outside world
  (`CLAUDE_SESSION_TOOLS` in `hosts/claude-code/tool-map.ts`).
  - For the read-only seats (2026-048), `SubagentHandback` is the existing
    `observe` action (a report to the commissioning seat) and `ToolSearch` is
    a `lookup`. The lead may use both. The scout may hand back but not
    `ToolSearch`: it holds no deferred tool. No new action kind; the core
    names no host tool.
  - A read-only seat's `SendMessage` stays refused, now with the way forward:
    a scout is not continued (the lead commissions a fresh one), and an
    architect is continued through `bounded lead reply`.
  - In a ticket seat, which runs only what the gate judges (2026-066), both
    count as judged and are allowed in words. A tool `ToolSearch` loads is
    still judged when it is called.
- **A seat may re-read its own saved output.** A `Read` of
  `<projects-dir>/<session_id>/tool-results/<name>.txt` is allowed only when
  the caller's own transcript (its `subagents/agent-<id>.jsonl`, or the main
  transcript for a top-level seat) records that its own call produced it.
  - Proof: a `user` record's `tool_result` whose text starts with exactly
    `<persisted-output>` and then
    `Output too large (…). Full output saved to: <path>` for the requested
    path, and whose `tool_use_id` names an earlier `tool_use` in the same
    transcript. Nothing after those two lines counts, so a preview cannot
    claim another file. A mere mention is not ownership.
  - Not "any file of the session": every subagent writes to one shared
    `tool-results/` directory, so that would let a blind test-writer read a
    parallel builder's output (2026-034's blindness).
  - The rule is role-independent and judged in the adapter before the seat's
    own dispatch: the content came from the caller's own, already-gated call.
    Only `Read`; `Grep`, `Glob` and Bash over `tool-results/` stay refused.
    `decide()` and every read zone are unchanged.
  - In a ticket seat this is the one read allowed outside the worktree,
    allowed in words. Elsewhere it is left to Claude Code's own permissions.
- **Fail closed.** The transcript layout is Claude Code's and undocumented.
  A missing `transcript_path` or `session_id`, a `transcript_path` not named
  `<session_id>.jsonl`, an unreadable transcript or any unparseable line, a
  path that is not a plain file directly in `tool-results/` once resolved,
  or no matching record: refused, as before.
- **Refusals name the refused seat.** A read-only seat borrows the
  architect's read zone, but its refusal reads `scout: may not read …`, not
  `architect may not read`.

## Consequences

A layout change in Claude Code turns these reads back into refusals, not into
an opening. Ownership rests on a tool result's text prefix, which the caller's
own call wrote. Pi is unchanged: its scout reports through
`contact_supervisor`, and it has no saved-output directory.
