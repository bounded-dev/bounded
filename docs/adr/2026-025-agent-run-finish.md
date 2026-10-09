# 2026-025: Observing a delegated agent run's finish: `AgentRunFinished`, `onAgentRunFinish`, Claude Code's SubagentStop, and `bounded/prereqs` counting runs by their resolved agent

**Status:** accepted (the 1b outline of the prerequisites pack, one plan
review, payload captures, and decisions the orchestrator made for the
maintainer, marked below). Ships in `bounded` 3.3.0, unreleased, with no
version bump of its own. Amends [ADR 2026-005](2026-005-events-verdicts-dispatch.md)
(an observation beside the guard events), [ADR 2026-006](2026-006-effects.md)
(a result entry's fields), [ADR 2026-013](2026-013-restructure.md) (a
lifecycle point and a judge method), [ADR 2026-019](2026-019-prereqs-pack.md)
(its interim limit, `require`, its future work and its records) and
[ADR 2026-022](2026-022-bounded-log.md) (the event kind the Bounded log
records).

## Context

ADR 2026-019 counted only a run the host reports finished on its result. In
interactive Claude Code most subagents run in the background, so their
result arrives at launch, and nothing counted them. Claude Code reports a
background run's end with the SubagentStop hook.

### What the captures show

Captured with `claude -p` and haiku. Each capture is named as the
maintainers' capture notes name it; the payloads the tests use are pinned,
scrubbed, in `src/hosts/claude-code/test/fixtures/agent-responses/`.

- **run1-p (Claude Code 2.1.294):** an Agent call with no
  `run_in_background` ran in the background. PostToolUse
  `{ isAsync: true, status: "async_launched", agentId, … }` (no `agentType`)
  came first; then SubagentStop with the same `agent_id`,
  `agent_type: "plan-reviewer"`, `stop_hook_active`, `last_assistant_message`,
  and `background_tasks` listing the run itself as "running".
- **run2-fg (2.1.294):** with background tasks disabled, SubagentStop came
  **before** PostToolUse `{ status: "completed", agentId, agentType,
  harnessNoteCount: 0, … }`.
- **run3-maxturns/fg (2.1.294):** a run stopped at its turn limit reported
  `completed` with `harnessNoteCount: 1` and a note that it stopped before
  finishing; **no SubagentStop** fired.
- **run4-maxturns-bg (2.1.294):** a turn-limited background run gave
  `async_launched` and SubagentStart, and **no SubagentStop**; the main
  session was told the agent stopped at its turn limit with no report.
- **run5-casefold-fg and run6-casefold-bg (2.1.294):** `subagent_type`
  "Plan-Reviewer" ran the definition plan-reviewer. `tool_input` keeps
  "Plan-Reviewer"; SubagentStop's `agent_type` and `tool_response.agentType`
  say "plan-reviewer". The foreground order is SubagentStop then the
  completed result; the background order is the launch result then
  SubagentStop.
- **run7-mixed-def (2.1.294):** a definition named "Mixed-Case", requested
  as "mixed-case", reports `agent_type` and `agentType` "Mixed-Case": the
  resolved name is the definition's own, not a folded one.
- **run8-taskstop (2.1.294):** a background run stopped with TaskStop gave
  `async_launched`, SubagentStart and the TaskStop result, and **no
  SubagentStop**.

Not captured: a user interrupt (Esc), an API-error end, Ctrl+B on a
foreground run, and whether SubagentStop ever carries an empty `agent_type`.

## Decision

### The core

- **`AgentRunFinished` is an observation, not an `Event`.** It sits beside
  `ToolResult`: `{ kind: "agent-run-finished", role, agent, agentRunId,
  ranToEnd }`, every field but `kind` required. `agent` is the agent that
  ran as the host resolved it; `ranToEnd` is true, false, or null when the
  host does not say; `role` is that of the session the hook runs in. It
  names no delegation, so a top-level session can become a source later.
  Guards never see it: `Event.parse`, `decideEvent` and `judge` refuse it,
  since a finish has already happened and nothing can refuse it.
- **`AgentRunId`** is a value object like `CallId`: non-empty text without
  control characters, at most 256 characters.
- **The point `corePack.points.onAgentRunFinish`**, declared with
  `functionOf` as the other lifecycle points are, takes
  `AgentRunFinishHandler = (finish, context) => Promise<AgentRunFinishReport>`.
  `AgentRunFinishReport` is `{ record: { verdict, note } | null }`, parsed as
  `AfterToolReport` is: no message (no agent is told of a finish) and no
  effect (the core names the contributing pack on every refusal).
- **`recordAgentRunFinish`, which never rejects, with the parse split of
  `afterTool`.** `ProjectJudge.recordAgentRunFinish(finish: unknown)` parses
  the wire form; one that cannot be read is recorded with `Decision.invalid`
  ("The host sent an agent run's finish that cannot be read: …", redirect
  "Report this to the maintainers of the host adapter") and no check runs.
  `ProjectLifecycle.recordAgentRunFinish(finish: AgentRunFinished)` runs every
  check in pack order, all of them, and writes each non-null record, a
  refusal naming its pack. A check that throws or reports nonsense is
  recorded as a refusal naming its pack ("<pack> could not handle the finish
  of <agent>'s run <id>: …"), and later checks still run. A record that
  cannot be written is swallowed. **Only what packs report is recorded:** no
  record, no line. The refusing judges (both forms in `open-project.handler.ts`,
  and `openProject`'s `refusingAll`) do nothing, as their `afterTool` does.
- **The decision line keeps its shape** (the orchestrator's decision, for
  the maintainer). The Bounded log gains only the event kind
  `"agent-run-finished"`, with `tool: null` and no effects, as a session start
  has. The run is named in text: the note is
  "<agent>'s run <id> finished (ran to its end: yes|no|not said): <pack's
  note>", and a pack's refusal reason names the agent and the run.

### The result side (amends ADR 2026-006)

A `delegatedAgentRuns` entry gains three optional fields, each written by
`toJSON` only when given:

- `agentRunId`: the run's id, when the host gives one.
- `finishReportedLater: true`: the run goes on after this result, and the
  host reports its finish later with this id. Only with `finished: false`
  and an `agentRunId`, never with `finishNeverReported` ("A tool result's
  delegatedAgentRuns entry may say finishReportedLater: true, and only when
  finished is false, it gives the run's agentRunId and it does not say
  finishNeverReported"). It tells a launch from a turn-limited run, which
  also has an id but no finish to come.
- `resolvedAgent`: the agent the host actually ran. The delegate effect's
  `agent` stays the requested name.

`ToolResultJSON.delegatedAgentRuns` is typed by a JSON twin,
`DelegatedAgentRunJSON`; the domain entry carries the value objects.

### `bounded/prereqs`

- **`require` matches the host's resolved agent exactly, in both orders**
  (the orchestrator's decision, for the maintainer). The resolved name is
  authoritative: run5, run6 and run7 show it is the definition's own name. A
  requested spelling that resolves to the required agent counts
  ("Plan-Reviewer" runs plan-reviewer, which meets `require: { delegate:
  "plan-reviewer" }`); a resolved name that differs, even in case only, does
  not; with no resolved name, the run does not count. `before.delegate`
  still folds case and spaces on the requested name, as in ADR 2026-019.
- **Candidates at the call.** A requested name cannot be resolved until the
  host reports it, so `PrerequisiteRule.mayResolveToRequiredAgent` folds case
  and surrounding spaces, as Claude Code resolves. Every candidate gets
  ADR 2026-019's call-time refusals and has its starts kept, under the
  rule's required agent. `requiresDelegationTo` stays exact and is applied
  to the resolved name.
- **The foreground order** (the finish before its completed result): the
  finish finds nothing kept for its run and does nothing; the result records
  against each start whose agent equals its `resolvedAgent` exactly. This
  changes ADR 2026-019's foreground path, which recorded on `finished: true`
  alone. With no `resolvedAgent` the agent is told the host did not say which
  agent ran; a resolved agent that differs is told by name.
- **The background order** (the launch result, then the finish): a
  successful launch whose finish is reported later moves its call's starts
  to its run (`saveStartedForRun`) and says nothing. A failed launch keeps
  nothing. A start that cannot be kept is told and recorded as a refusal.
- **The finish** (`recordRunAtFinish`) takes the run's starts. Nothing kept
  reports nothing: a foreground run, an agent no rule needs, an expired
  start, a duplicate finish. Otherwise every outcome is recorded, since no
  agent is told of a finish and the Bounded log is the only place to see why
  a background run did not count: a start that cannot be read or was
  altered, `ranToEnd: false`, an agent other than the required one, files
  that changed, match nothing or cannot be fingerprinted, or a record that
  cannot be written, are refusals; a run over unchanged files appends a
  record with the launching call's id and an allow. The finish reads no
  rules.
- **`true` and `null` count; `false` never does** (the orchestrator's
  decision, for the maintainer). Claude Code always sends `null`.
- **`pending`.** `PrerequisiteStatus` gains `pending`: no record holds, and a
  run still to finish keeps a start for the rule's requirement over the
  files as they are now. The refusal is "…, and <agent>'s run started at <T>
  has not finished yet: wait for its finish. This call would …", with the
  redirect "Wait for <agent>'s run started at <T> to finish (it is recorded
  when it does); if it stopped without finishing, <rule's redirect>". Pending
  never allows; runs that cannot be read refuse.
- **ADR 2026-019's not-finished message is reworded**, since background runs
  now count at their finish: "<agent>'s run was not seen to finish, and the
  host will not report a later finish (as for a run stopped at its turn
  limit), so it is not recorded; run <agent> again, to its end".
- **The run-start store.** `PrerequisiteRecords` gains `saveStartedForRun`,
  `takeStartedForRun` and `readStartedForRuns`. The store stamps `startedAt`
  (a pack has no clock port). On disk a run's starts are
  `.bounded/prereqs/started/runs/<sha256 of the run id>.json`, written whole,
  kept seven days and swept on save; listing skips temporary files and a file
  gone between listing and reading. A stored run is a `PendingAgentRun`
  value object, `{ agentRunId, callId, startedAt, starts }`.

### Claude Code

- **Results:** `delegatedAgentRunOf(response)` gives `agentRunId` from
  `agentId` for `completed` and `async_launched`; `finishReportedLater` only
  for `async_launched` with `isAsync: true` and an id; and `resolvedAgent`
  from `agentType` of a finished run. PostToolUseFailure gives
  `{ finished: false }`.
- **SubagentStop** is routed before the PreToolUse path and handed to
  `recordAgentRunFinish` as `{ kind: "agent-run-finished", role, agent:
  agent_type, agentRunId: agent_id, ranToEnd: null }`, a missing field sent
  as null so the core records it as unreadable. An empty `agent_type` sends
  nothing: no rule can require a nameless agent. `stop_hook_active`,
  `background_tasks` and `last_assistant_message` are not read. The answer is
  always empty, raced against the hook's deadline; a failure is not
  recorded. Without `CLAUDE_PROJECT_DIR` (`refuseAll`) a SubagentStop is
  answered with nothing too: a deny means nothing there, and a block would
  keep the subagent running.
- **The installer has one installed form and its older forms per event**,
  so install stays idempotent: the tool events run the wrapped command
  (`{\n<command>\n} || { echo …; exit 2; }`) and replace the bare command and
  the earlier wrapper; SubagentStop (matcher "") runs the bare command and
  replaces both wrapped forms, since exit 2 there blocks the stop.
  `bounded update` adds SubagentStop to an earlier install through the same
  install, and its restart notice follows the settings change.
- **The fixtures** live in the app's `test/` and are read with
  `readFileSync`, never imported, since an app's other files never import
  from its `test/` (ADR 2026-024).

## Limits

- **A finish that never comes means the run never counts.** Captured:
  turn-limited runs (run3, run4) and TaskStop-stopped runs (run8) fire no
  SubagentStop. Such a run shows `pending` for up to seven days, and the
  redirect says to run the agent again; a new run that finishes then holds.
- **Unknown and uncaptured:** Ctrl+B on a foreground run (if its result is
  not `async_launched` with `isAsync: true`, no start moves and the agent is
  told no later finish will be reported); a finish that arrives before its
  launch result (it finds nothing, so the run never counts); a launch hook
  that failed.
- **Unknown and uncaptured, failing open if they fire SubagentStop:** a user
  interrupt (Esc) and an API-error end. If either fires SubagentStop, Claude
  Code says nothing of how the run ended, so `ranToEnd` is null and the run
  counts as having run to its end.
- **A forged finish:** anything running as the user can pipe a SubagentStop
  payload to the hook, the same-user limit every hook has.
- **pi** is unchanged: every entry says `finishNeverReported` until item 1c.

## Release

Ships in 3.3.0, additive: a new optional entry field set, a new event kind,
a new point, and a new required method on `ProjectJudge`. `openProject`
builds the judge, so a host that calls it gains the method; only a
third-party implementation of `ProjectJudge` would need to add it.

## Consequences

- A host that sees a delegated run end calls `recordAgentRunFinish`; a pack
  observes it through `onAgentRunFinish`.
- Background Claude Code subagents meet `bounded/prereqs` requirements;
  disabling background tasks is no longer needed.
- The Bounded log holds `agent-run-finished` lines only when a pack reports
  one.
