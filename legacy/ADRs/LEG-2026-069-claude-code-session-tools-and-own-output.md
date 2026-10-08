# LEG-2026-069: Claude Code's session tools, and a seat re-reading its own saved output

**Status:** accepted. Amends LEG-2026-034, LEG-2026-048 and LEG-2026-066.

## Context

In the 2026-10-02/03 dogfood run (#47), the scout's `SubagentHandback` was
refused six times and both scout reports were lost. The lead could not load a
deferred tool with `ToolSearch`. Seats could not read the file Claude Code
saves a too-large tool result to, because that file is outside the project.

## Decision

- **Session tools.** `SubagentHandback` and `ToolSearch` act on the
  conversation, never on the project or the outside world
  (`CLAUDE_SESSION_TOOLS` in `hosts/claude-code/tool-map.ts`).
  - For the read-only seats (LEG-2026-048), `SubagentHandback` is the existing
    `observe` action (a report to the commissioning seat) and `ToolSearch` is
    a `lookup`. The lead may use both. The scout may hand back but not
    `ToolSearch`: it holds no deferred tool. No new action kind; the core
    names no host tool.
  - A read-only seat's `SendMessage` stays refused, now with the way forward:
    a scout is not continued (the lead commissions a fresh one), and an
    architect is continued through `bounded lead reply`.
  - In a ticket seat, which runs only what the gate judges (LEG-2026-066), both
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
    transcript. A `Preview (first 2KB):` line must follow (the one label
    measured; any other is refused), and the preview
    must be exactly the whole preview Claude Code writes for that file. That
    format was measured on 134 real saved outputs from one developer
    machine, and all 134 pass the rule: the file's first 2000 characters, with leading line breaks
    dropped, cut back to the last line break when one falls in the second
    half, then `\n...\n</persisted-output>`. For a shorter file it is the
    whole file. So for a "first 2KB" preview, between 1000 and 2000
    characters of the file are bound, every one of them. An empty file
    proves nothing. A seat's own tool can print the header lines, but not
    another seat's output it has never seen. A mere mention is not
    ownership.
  - A call with no agent id is judged against the main transcript only for
    the session's top-level seat (the lead, or a read-only seat). A role
    seat's call with no agent id is refused. That is a known limit: such a
    role cannot re-read its own saved output, because its own transcript
    cannot be told apart from the main one.
  - No refusal or guard-log line names a saved output outside the project.
    The guard log has one redaction socket that a host adapter fills
    (`addGuardLogRedactor` in `src/guard-log.ts`). Claude Code's
    `redactSavedOutputs` is registered there, and it is applied to every
    answer of the path-gate hook. Two kinds of path become "a saved tool
    output", in file tools, searches and Bash commands alike: any absolute
    path with a `tool-results` directory outside the project, and any path
    ending in `tool-results/<name>.txt`, whatever its prefix (`~`, `../`,
    none), unless it is an absolute path inside the project. So other seats
    cannot learn the names.
  - Not "any file of the session": every subagent writes to one shared
    `tool-results/` directory, so that would let a blind test-writer read a
    parallel builder's output (LEG-2026-034's blindness).
  - The rule is role-independent and judged in the adapter before the seat's
    own dispatch: the content came from the caller's own, already-gated call.
    Only `Read`; `Grep`, `Glob` and Bash over `tool-results/` stay refused.
    `decide()` and every read zone are unchanged.
  - In a ticket seat this is the one read allowed outside the worktree,
    allowed in words. Elsewhere it is left to Claude Code's own permissions.
- **Fail closed.** The transcript layout is Claude Code's and undocumented.
  A missing `transcript_path` or `session_id`, a `transcript_path` not named
  `<session_id>.jsonl`, an unreadable transcript or any unparseable line
  (apart from a final one with no newline yet, still being written), a
  path that is not a plain file directly in `tool-results/` once resolved,
  or no matching record: refused, as before.
- **Refusals name the refused seat.** A read-only seat borrows the
  architect's read zone, but its refusal reads `scout: may not read …`, not
  `architect may not read`.

## Consequences

A layout change in Claude Code turns these reads back into refusals, not into
an opening. A change to the preview format does the same: genuine reads are
refused until the rule is re-measured. Ownership rests on text Claude Code
writes, not on anything it signs. The residual risk is a seat that can predict
the whole preview of another seat's output, its first 1000 to 2000
characters, exactly: for example a deterministic command run on the same
tree. That seat could write a matching tool result into its own transcript
through its own tool and claim the file. Pi is unchanged: its scout reports through
`contact_supervisor`, and it has no saved-output directory.
