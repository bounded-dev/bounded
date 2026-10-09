# Captured Claude Code agent payloads

Hook payloads Claude Code 2.1.294 sent for Agent calls, captured with
`claude -p` and the haiku model in a scratch project, then scrubbed. The tests
read them as text and pass them to the hook as Claude Code does on stdin
(ADR 2026-025); nothing imports them.

| File | Capture | What it shows |
| --- | --- | --- |
| `background-pre-tool-use.json` | run1-p | PreToolUse for an Agent call with no `run_in_background` |
| `background-post-tool-use.json` | run1-p | PostToolUse at launch: `isAsync: true`, `status: "async_launched"`, `agentId`, no `agentType` |
| `background-subagent-stop.json` | run1-p | SubagentStop after the launch result: `agent_id` equal to the launch's `agentId`, `agent_type`, `background_tasks` listing the run as running |
| `foreground-subagent-stop.json` | run2-fg | SubagentStop, before the result (background tasks disabled) |
| `foreground-post-tool-use.json` | run2-fg | PostToolUse with `status: "completed"`, `agentId`, `agentType` and `harnessNoteCount: 0` |
| `turn-limited-post-tool-use.json` | run3-maxturns/fg | a foreground run stopped at its turn limit: `status: "completed"` with `harnessNoteCount: 1` and the turn-limit note; no SubagentStop was sent |
| `turn-limited-background-pre-tool-use.json` | run4-maxturns-bg | PreToolUse for a turn-limited agent, run in the background |
| `turn-limited-background-post-tool-use.json` | run4-maxturns-bg | its launch result; no SubagentStop was sent |
| `case-folded-foreground-pre-tool-use.json` | run5-casefold-fg | `subagent_type: "Plan-Reviewer"`, `run_in_background: false` |
| `case-folded-foreground-subagent-stop.json` | run5-casefold-fg | `agent_type: "plan-reviewer"`, before the result |
| `case-folded-foreground-post-tool-use.json` | run5-casefold-fg | `agentType: "plan-reviewer"`; `tool_input` keeps "Plan-Reviewer" |
| `case-folded-background-pre-tool-use.json` | run6-casefold-bg | `subagent_type: "Plan-Reviewer"`, in the background |
| `case-folded-background-post-tool-use.json` | run6-casefold-bg | its launch result |
| `case-folded-background-subagent-stop.json` | run6-casefold-bg | `agent_type: "plan-reviewer"`, after the launch result |
| `mixed-case-definition-post-tool-use.json` | run7-mixed-def | a definition named "Mixed-Case", requested as "mixed-case": `agentType: "Mixed-Case"` |
| `mixed-case-definition-subagent-stop.json` | run7-mixed-def | `agent_type: "Mixed-Case"` |
| `task-stopped-pre-tool-use.json` | run8-taskstop | PreToolUse for a slow agent, run in the background |
| `task-stopped-post-tool-use.json` | run8-taskstop | its launch result |
| `task-stopped-task-stop-post-tool-use.json` | run8-taskstop | PostToolUse for TaskStop stopping it; no SubagentStop was sent |

## What was replaced

Every key, id, `tool_use_id`, `status`, `isAsync`, `harnessNoteCount`,
`agentType`, `agent_type`, `background_tasks` entry and `task_id` is as
captured, and so is the turn-limit note. These were replaced:

- `cwd`: `/project`.
- `session_id` and `prompt_id`: a fixed UUID per capture.
- `transcript_path` and `agent_transcript_path`: under
  `/home/user/.claude/projects/project/`, named by the fixed session id.
- `outputFile`: under `/tmp/claude/project/`, named by the fixed session id.
- Paths in prompts: `/project/plan.md`, or `/project` for the directory.
- The review text in `last_assistant_message` and `content[].text`:
  "Finding: the plan is a stub.\n\nVerdict: revise". The originals quoted
  instructions from the capture session's tools.
