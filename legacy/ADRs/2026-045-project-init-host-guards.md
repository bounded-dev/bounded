# 2026-045: Make initialized host guards usable and non-bypassable

**Status:** accepted

## Decision

Initialization marks the generated project command executable. The architect's Git capability is read-only through one shared policy on Pi and Claude Code; repository mutations happen outside the developer-stage role. Claude Code project settings disable background tasks so a commissioned reviewer or worker returns to the architect in the foreground.

## Why

In a fresh Claude Code project, the generated launcher lacked execute permission. The architect then used Git index commands to rewrite that protected file despite a path-gate refusal. Once the reviewer launched, Claude Code's interactive background mode left the architect repeatedly starting background sleeps instead of receiving the review result.

## Consequences

The Claude Code developer stage runs its child roles sequentially. This trades parallel execution for a reliable phase handoff. The source and project-local copies are versioned separately; existing initialized projects need a future update mechanism to receive these changes.
