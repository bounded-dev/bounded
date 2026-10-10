# 2026-028: pi reports a delegated run's finish: pi-subagents' async completion and its synchronous results feed `AgentRunFinished` and `delegatedAgentRuns`, and a resume is judged as a delegation to the agent bounded tied to its run

**Status:** accepted (item 1c of the prerequisites pack, `prereqs-1c`; one
plan review, and decisions the orchestrator made for the maintainer, marked
below). Ships in `bounded` 3.3.0, unreleased, with ADR 2026-025, with no
version bump of its own. Amends [ADR 2026-019](2026-019-prereqs-pack.md)
(its pi mapping, its pi limit and the redirect it quotes) and
[ADR 2026-025](2026-025-agent-run-finish.md) (its pi limit).

## Context

Until now no delegated run on pi ever counted toward a `bounded/prereqs`
requirement: bounded's pi adapter could not see a run finish, so every
delegation of a `subagent` call was `finishUnreported` and every result
entry `finishNeverReported` (ADR 2026-019). ADR 2026-025 gave the core a
host-neutral finish, `AgentRunFinished`, which Claude Code feeds from
SubagentStop.

**The payloads are derived from source, not captured.** pi-subagents
0.52.1, the version `docs/adapter-pi.md` names, was read from its source
(the only copy on the machine, since removed by the maintainer, and not
reinstalled, by the orchestrator's decision); pi 0.87.1 from its global
install. No pi-subagents run was captured. The fixtures in
`src/hosts/pi/test/fixtures/pi-subagents/` follow the cited lines exactly,
and each names the version and the file and line it follows in its
`"_source"` field. Every reading of them fails closed. Paths below are
package-relative.

### What the source shows

- **One shared event bus.** pi gives every extension `pi.events`, "Shared
  event bus for extension communication" (`dist/core/extensions/types.d.ts:1157-1158`),
  one bus for all the extensions it loads (`dist/core/extensions/loader.d.ts:17,22`).
  `on(channel, handler)` returns an unsubscribe; `emit` does not await
  handlers and catches and logs what they throw (`dist/core/event-bus.js:2-23`).
  pi unsubscribes every bus subscription an extension made when its
  context is invalidated, on a reload or a session replacement
  (`dist/core/extensions/loader.js:142-155`).
- **The completion.** pi-subagents emits `subagent:async-complete`
  (`src/shared/types.ts:1784`) on `pi.events` when an async run's result
  file is delivered (`src/runs/background/result-watcher.ts:559-577`),
  consumes it itself through the same bus (`src/extension/index.ts:741-750`)
  and documents it as public (`docs/observability.md:228-241`,
  `docs/extension-api.md:37`). It fires only in the session that owns the
  run (`result-watcher.ts:412`), after its own notification was accepted
  (`:523-547`), and never again for a result already delivered (`:491-501`).
- **The completion comes from a file.** The watcher reads result files from
  pi-subagents' results directory, under the OS temp directory
  (`docs/observability.md:143,155`), and accepts any whose `sessionId` and
  `completionOwnerId` match the session (`result-watcher.ts:298-309,412`);
  both values are written in the run's own `status.json`
  (`src/runs/foreground/subagent-executor.ts:3996-4013`).
- **Every public call runs exactly one agent.** The `subagent` tool runs
  `executePublic` (`src/extension/index.ts:607-610,647-649`), which refuses
  `tasks`, `chain`, `parallel` and `concurrency`
  (`src/extension/public-execution.ts:66-69`) and turns `{ agent, task }`
  into a workflow that runs that one agent (`:107-127`).
- **The tie between a launch and its completion.** A workflow runs in the
  background unless the call says `async: false` (`subagent-executor.ts:3907`),
  under a fresh run id (`:3912`). The launch's result is
  `details: { mode: "workflow", runId, toolCallId, asyncId: runId, asyncDir, results: [] }`,
  with no `isError` (`:4387-4390`), and pi hands `details` to `tool_result`
  handlers (`types.d.ts:791-799,832-835`). The result file, and the
  completion, carry the same `runId` (`subagent-executor.ts:4344,4376`;
  `result-watcher.ts:395,559-577`). So the launch's `details.asyncId` is
  the completion's `runId`.
- **The agent.** Each completion child is `{ workflowKey, agent?, runId?,
  output, outputState, success, detached? }` (`subagent-executor.ts:4344,4376`),
  and the emitted copy adds `status`, always set, `summary` and `index`
  (`result-watcher.ts:470-478,559-577`). A child's `agent` is the agent
  pi-subagents ran (`subagent-executor.ts:3598-3602`), matched by exact name
  (`src/runs/foreground/execution.ts:1550`) after alias resolution
  (`docs/tool-reference.md:183`). A child with no `agent` is given the run's
  (`"workflow"`) or `step-<n>` (`result-watcher.ts:469`).
- **How a run stopped.** A completion's `state` is `"complete"`, `"failed"`,
  `"stopped"` or `"paused"`, and `success` is `state === "complete"`
  (`subagent-executor.ts:4343-4376`); a child's `success` is
  `isError !== true && !detached` (`:3588`). A synchronous result's
  `details.results` are the children's own results (`:4492-4495`), with
  `isError: true` when the workflow failed (`:4507-4511`), compacted without
  `task`, `messages` and `progress` (`src/shared/utils.ts:435-455`). A
  timed-out child has `timedOut` and an error (`execution.ts:1097-1119,1158-1178`),
  and an error with exit 0 becomes exit 1 (`:1362-1364`), so it fails. An
  **interrupted** child exits 0 with `interrupted: true`
  (`execution.ts:1343-1347`) and is returned without `isError`
  (`subagent-executor.ts:3476-3481`): its async completion says success,
  with no interrupt flag; its synchronous result keeps `interrupted: true`.
- **`forceTopLevelAsync`** only decides the one-foreground-call guard
  (`subagent-executor.ts:5669-5675`).
- **Resume.** `subagent({ action: "resume", id | runId | dir, index?, message })`
  routes to `resumeAsyncRun` (`subagent-executor.ts:4831-4833`). The run it
  resumes is chosen by `resolveResumeTarget` (`:1531`) from `id`, `runId`,
  `dir` and `index` (`src/runs/background/async-resume.ts:15-20,207-243`):
  an exact run id, a directory, or a unique prefix. The revived agent is the
  stored agent of the child at `index` (`async-resume.ts:34-49`), and a new
  async run starts from the stored session (`subagent-executor.ts:1707,1737`).
  Until now bounded translated a resume as `invoke subagent.resume` only,
  so no `before: { delegate }` rule saw which agent ran: a fail-open.

## Decision

### Results: what a `subagent` result says of its run

- **No run call's delegation is `finishUnreported`** any more, whatever its
  `async` says; an `async` that is not a boolean is still refused. Whether a
  run goes on in the background is read from its result's `details`, never
  from the call.
- **A result is paired with a run only when its call has exactly one
  delegate effect and is not a resume.** Otherwise every entry is
  `{ finished: false, finishNeverReported: true }`.
- **An async launch** is a result whose `details` has an `asyncId`. Its
  entry is `{ finished: false, agentRunId: <asyncId>, finishReportedLater: true }`
  only when all of these hold; otherwise it is `finishNeverReported`:
  `isError` is not true; `details.mode` is `"workflow"`; `details.toolCallId`
  equals the event's call id; `details.results` is an empty array; the
  `asyncId` is an `AgentRunId`; and the extension subscribed on pi's event
  bus.
- **A synchronous result** ran to its end when `isError` is not true,
  `details.results` has exactly one entry, with `exitCode` 0, and none of
  `interrupted`, `detached`, `timedOut`, `stopped`, `turnBudgetExceeded` is
  true. Then its entry is `{ finished: true, resolvedAgent }`, the child's
  `agent` (left out when it is not a valid agent name). A readable result
  that stopped early is `{ finished: false }`; unreadable `details` are
  `finishNeverReported`. It carries no `agentRunId`.

### The completion

- **The extension subscribes to `subagent:async-complete` on `pi.events`
  once, when it loads**, the public, documented seam. It keeps no
  unsubscribe of its own: pi unsubscribes it on a reload or a session
  replacement (`loader.js:142-155`). `Pi.events` is optional: without a bus,
  an async launch says `finishNeverReported`, and synchronous results still
  count.
- **The payload is read when it arrives, before any await,** into plain
  values: what pi-subagents or another listener does to the shared object
  later cannot change what is recorded.
- **A completion is sent as `{ kind: "agent-run-finished", role: null, agent, agentRunId, ranToEnd }`**
  to `recordAgentRunFinish`: `agent` is its one child's `agent` and
  `agentRunId` its `runId`, each null when it is not non-empty text (the
  core then records it as unreadable, ADR 2026-025). A completion without
  exactly one child sends nothing. Its `toolCallId` is not used.
- **`ranToEnd` is true only when** `state` is `"complete"` and `success`
  true, the child's `success` true and its `status` `"completed"`, and none
  of `detached`, `interrupted`, `timedOut`, `stopped`, `turnBudgetExceeded`
  is true on the child or the payload. Otherwise it is false, never null.
- **The handler waits for the session's composition and records.** It drops
  a completion before `session_start` or when composing failed, runs no
  deadline (pi does not await it), and swallows a failure.
- `subagent:foreground-complete` is not observed.

**The pack is unchanged** but for one redirect: ADR 2026-025 covers both
orders, a launch whose finish is reported later and a finished result. The
redirect for a delegation whose finish goes unreported is now host-neutral,
"Run <agent> as a new run whose finish the host reports" (it was "… (not as
a teammate or an asynchronous run)"), also true of a pi resume. The core's
behaviour does not change; its comment on `finishNeverReported` no longer
names pi.

### Resume

- **What ties a run to an agent (plan review, M1).** The adapter keeps, per
  extension load and in memory only, the runs it observed itself:
  - an async launch that passes the checks above, under its `asyncId` and
    the event's call id, holding its one delegate effect's agent, untied;
  - a synchronous result that ran to its end, under the event's call id,
    when `details.runId` equals it, tied to the child's `agent` only when
    that equals the delegate effect's agent exactly.

  Nothing else fills it: not a resume's result, not a call with more than
  one delegation, and never an id taken only from a completion (its
  `toolCallId`, a child's `runId`, or a run bounded never saw launched). An
  entry is never overwritten. A completion ties a launch only when its
  `runId` is the launch's `asyncId`, it names exactly one child, and that
  child's `agent` equals the launch's agent exactly, whether it ran to its
  end or not (a stopped run's agent is still known). A completion that
  disagrees (another agent, or more or fewer than one child) removes the tie
  for good, under both ids; a later agreeing one does not restore it.
- **A resume is tied (M2)** only when it gives exactly one of `id` and
  `runId`, as non-empty text, that names a tied run; with no `dir`; and an
  `index` absent or 0. A tied resume is translated as
  `[{ kind: "delegate", agent, finishUnreported: true }, { kind: "invoke", name: "subagent.resume" }]`,
  so every `before: { delegate }` rule sees the agent it revives.
- **An untied resume is refused by the translation, whatever the project's
  rules** (the orchestrator's decision Q3, option B), after the check that a
  `dir` is inside the project. The reason: "pi's subagent call resumes run
  '<id>' (or a run it names by directory or index, or not by exactly one run
  id), which bounded did not see launched and finish as one agent in this pi
  session, so it cannot tell which agent would run"; the redirect: "Start a
  new run of the agent instead: subagent({ agent, task }) with the agent and
  the task you meant to resume". The translation's failure carries an
  optional `redirect` the extension uses; every other refusal keeps the
  fixed one. Rejected, option A: a core marker for a delegation whose agent
  is unseen, which would have amended ADR 2026-006 and broken the public
  delegate-guard type.
- **A resumed run's finish never counts.** Its delegation is
  `finishUnreported`, so the pack refuses a resume of an agent some rule
  requires, at the call, with "Run <agent> as a new run whose finish the
  host reports"; its result entry is `finishNeverReported`. It continues the
  earlier run's stored session, and its completion comes from a runner whose
  result shape this item did not read (`subagent-executor.ts:1737`). A
  resume of an agent no rule requires is unaffected.

## Limits

- **The main trust gap of pi completion: a completion can be forged from a
  file. Anything running as the user, the guarded agent's own shell
  included, can write a result file in pi-subagents' results directory under
  the OS temp directory, and pi-subagents then reports it as a completion.
  On pi this can count a pending review early.** The watcher accepts any
  result file whose `sessionId` and `completionOwnerId` match the session
  (`result-watcher.ts:298-309,412`); both are in the run's `status.json`
  (`subagent-executor.ts:3996-4013`); and the directory is outside the
  project, so the protected-paths pack does not guard it. A forged
  completion must name a run bounded launched and is waiting on, as the
  required agent, and fingerprints still apply, so it counts only over files
  unchanged since that launch. Nothing in pi or pi-subagents authenticates a
  completion.
- **An interrupted async run counts** (the orchestrator's decision Q1,
  option a). pi-subagents reports it as a success, with no interrupt flag.
  Another extension can interrupt a run through the RPC `interrupt` method
  (`docs/extension-api.md:26`), and possibly the user can (not verified);
  the guarded agent cannot, because bounded refuses the `interrupt` action.
  The synchronous path has no such hole: it keeps `interrupted: true`.
- **Never counted:** a finish that arrives before its launch's result (it
  finds nothing kept); a run whose pi session ends first, which shows as
  pending for seven days; a run that fails before its agent starts; a
  detached foreground child; and an alias, which is not a call-time
  candidate (ADR 2026-025).
- **Agents pi-subagents names itself,** `workflow` and `step-<n>`
  (`result-watcher.ts:469`), are recorded as such, and meet no rule that does
  not name them.
- **Resume over-refusal after a restart.** What ties a run is in memory.
  After a pi restart or a reload, every resume of an earlier run is refused
  as unseen, even in a project with no delegate rules; the redirect is to
  start a new run.
- **Resumes that are refused or never count.** A resume of a run whose
  launch named another spelling than the agent that ran is refused as
  unseen, since it is tied only on an exact match; a resumed run never
  counts; and a resumed agent is looked up in the default agent scope
  (already deferred).
- **What ties a resume is not proof.** A forged completion that agrees with
  a real launch ties it, as above.
- **Version.** The shapes are pi-subagents 0.52.1's; another version may
  differ, and a shape the adapter cannot read fails closed.

## Release

Ships with ADR 2026-025 in 3.3.0, unreleased: additive in the core (a
comment), one redirect's text in `bounded/prereqs`, and the pi adapter's
mapping.

## Consequences

- On pi, an async or synchronous run of a required agent meets a
  `bounded/prereqs` requirement under the same rules as on Claude Code.
- A pi resume is a delegation every `before: { delegate }` rule sees, or is
  refused.
- The main trust gap of pi completion is the forged result file above.
