# The pi host adapter (`src/hosts/pi`, shipped in `bounded` as `bounded/hosts/pi`)

pi loads project extensions from `.pi/extensions/`. Bounded's is one: at
session start it composes the project's guards, and on every tool call it
turns pi's call into a host-neutral tool use, decides it, and answers pi.
Anything it cannot read, translate or decide in time blocks the call.

Its source is the private workspace app `src/hosts/pi`; `bounded`'s prepack
compiles it for Node into `bounded`'s `dist/hosts/pi/`, so it is installed
with `bounded` and exported as `bounded/hosts/pi`
([ADR 2026-016](adr/2026-016-cli-app.md)). A project configures its packs in `bounded.config.ts`
([configuring a project](configuration.md)).

The standalone installation writes a small Pi project extension that starts
the verified, project-pinned compiled executable. The worker checks the
release, managed packs and project source on every event, while the Pi
extension sends bounded messages and blocks calls if the worker fails.
`bounded check` verifies the generated loader for Pi-only and combined host
projects ([ADR 2026-041](adr/2026-041-standalone-pi-worker.md)).

## Reading order (about 15 minutes)

Every file below is in `src/hosts/pi/`.

1. `event.ts` — the tool use the adapter produces: the core's `ToolUse`,
   a tool kind and its effects (read, list, write, execute, fetch, delegate,
   invoke), each shell command read into its execute effect's reading, built
   through the core's own `ToolUse.parse`.
2. `pi-path.ts` — where a path argument really acts: pi's own rewrite
   (unicode spaces to " ", one leading `@` stripped, `~` and `~/` expanded,
   `file://` decoded), resolved against the session's directory, kept inside
   the project, then followed through links (with the native realpath, so a
   case-insensitive volume yields the stored case) to where it lands. A
   dangling link or a loop of links is refused. A read is located as pi's
   read opens it, fallback spellings included. POSIX paths only.
3. `translate.ts` — the table from pi's tools to calls (a tool kind and its
   effects, an execute's before its reading), and `subagent.ts`, the strict
   reading of the subagent tool. Pure, given the locator and the lookup of
   the runs a resume may name.
4. `subagent-runs.ts` — pi-subagents' runs as bounded sees them: what a
   subagent result says of its one run, the finish a completion on pi's
   event bus reports, and which runs a resume may name (ADR 2026-028).
5. `extension.ts` — the extension: `session_start` composes and starts
   preparing the shell command reader, `tool_call` translates, reads the
   call's shell commands, decides and answers; every failure, and every
   deadline missed, blocks. `tool_result` checks the finished call, and
   pi-subagents' completions are recorded as runs' finishes.
6. `install.ts` and `index.ts` — the loader file a project needs, and
   `bounded(root)`, the extension it hands the project to.

The tests beside each file show the behaviour. `extension.test.ts` drives
the whole extension through a fake pi; `pi-path.test.ts` and
`install.test.ts` also run under pi's own runtime (node, through the jiti pi
loads extensions with and pi's options, via `pi-runtime.test-support.ts`).
pi is found through `PI_CODING_AGENT_DIR`, else the `pi` on PATH, else the
global npm root; where it is not found those cases are skipped and the
test run prints why.

## The translation

| pi tool | tool kind | effects |
| --- | --- | --- |
| `read` | read | read `path`, as the spelling pi's read falls back to when the path does not exist (AM/PM with U+202F, NFD, curly apostrophe, NFD with curly apostrophe) |
| `write` | write | write `path`: create if it does not exist, else modify |
| `edit` | edit | write `path`: modify |
| `ls` | search | list `path` (the session's directory if none) |
| `find` | search | list `path`, filter `pattern` |
| `grep` | search | list `path`, filter `glob`; read `path`. The content pattern is not judged |
| `bash`, `powershell` | shell | execute `command`, with `cwd` the session's directory, project-relative (outside the project refuses) |
| `subagent` | subagent | see below |
| `web_fetch` | web | fetch `url` |
| `web_search` | web | invoke `web_search`: a search names no URL, so it is allowed or refused by name |
| anything else (custom, MCP, skills) | other | invoke the tool's name only (never execute: that is strictly a shell command). Its arguments say nothing reliable about what it touches; custom tools are to be described later by a declared per-tool translation table |

pi's built-in tools ignore a `cwd` argument, so the translation ignores it
too: their paths always start at the session's directory. The role is null
until roles are wired.

### The subagent tool (pi-subagents)

Read strictly, so nothing it does goes undescribed:

- Every field, at every level, must be on an allowlist; any other field
  (for example `workflowScript`, `reads`, `progress`) refuses the call,
  naming it.
- It runs agents through `agent`, `tasks[]` and `chain[]` (a step may have
  `parallel[]` tasks, read the same way). Each is a delegate effect; every
  task and step must name a string agent (a step with `parallel` may omit
  its own).
- An `output` file is a write, located from the call's `cwd` or the task's
  own (this tool honours `cwd`, which must be inside the project). `false`
  writes nothing; `true` refuses, as its file is not named.
- `action: "status"` is invoked by name (`subagent.status`), so a guard
  allows or refuses it by name. A run directory (`dir`) a status or resume
  names must be inside the project; that is checked first. Every action but
  status and resume refuses.
- `action: "resume"` revives an agent's earlier run, so it is judged as a
  delegation to that agent (ADR 2026-028): a **tied** resume is a delegate
  effect of the agent, `finishUnreported` (a resumed run never counts), then
  `invoke subagent.resume`. It is tied only when it names its run by
  exactly one of `id` and `runId`, as non-empty text, with no `dir` and an
  `index` that is absent or 0, and bounded saw that run in this pi session:
  launched by an async call whose completion then named exactly one child,
  as the agent the call asked for (under the launch's run id or its call
  id), or run to its end by a synchronous call as the agent it asked for
  (under its call id). A completion that disagrees removes the tie for good.
  Any other resume is **refused, whatever the project's rules**: bounded
  cannot tell which agent it would run. The redirect is "Start a new run of
  the agent instead: subagent({ agent, task }) with the agent and the task
  you meant to resume". What ties a run is kept in memory only, so after a
  pi restart or a reload every resume of an earlier run is refused, even in
  a project with no delegate rules.
- No run call's delegate effect is `finishUnreported`: whether its run goes
  on in the background is read from its result (see "A delegated run's
  finish"), never from `async`. An `async` that is not true or false
  refuses the call.
- An `agentScope` other than `"project"` refuses: agents found outside the
  project are not the project's to vouch for. Deferred: when `agentScope` is
  absent, pi-subagents searches user and project agents (`"both"`); the call
  is translated, and guards see the agent's name but not where it was found.

This reading follows the shapes of pi-subagents' schema (single agent,
tasks, chain with parallel). Version 0.52.1 runs workflows through
`workflowScript`, which is JavaScript the translation cannot describe, so
such calls are refused. Its public `subagent` tool refuses `tasks`, `chain`,
`parallel` and `concurrency` itself and turns `{ agent, task }` into a
workflow that runs that one agent (`src/extension/public-execution.ts:66-69,107-127`),
so a call bounded lets through runs exactly one agent; bounded still reads
`tasks` and `chain` for other versions.

## How it plugs in

```
.pi/extensions/bounded/index.ts      generated by piLoader(): an async factory
  -> import("bounded/hosts/pi")      fails closed: if this or the extension throws, every tool call is blocked
  -> bounded(root)                   src/hosts/pi/index.ts
     -> piExtension({ projectRoot, load, readShellCommand })  src/hosts/pi/extension.ts; load is the composition root's seam
        -> composeProject(root)      src/hosts/pi/composition-root.ts: openProject(root, { ports }) from bounded/open-project
        -> shellCommandReading       src/hosts/pi/composition-root.ts: openShellCommandReading(), bounded's reader, once per process
```

`load: () => Promise<decide>` starts at each `session_start`, without
delaying the session; tool calls await it. `decide(toolUse)` returns a
`Promise<Verdict>` (`bounded/domain`), as the core's judging is
asynchronous. Composing has a deadline of 15 s, each decision one of 3 s
(set through `bounded(root, { composeDeadlineMs, deadlineMs, composeBackoffMs })`): a
promise that never settles blocks the call instead of hanging pi. A
composition that runs out of time blocks the calls waiting for it and is
kept as failed for a back-off (30 s, `composeBackoffMs`), during which calls
are blocked saying it timed out and when it retries; the first call after
the back-off composes again, so slow imports do not pile up; one that fails blocks every call until a new
session. pi gets `undefined` to run the call, or
`{ block: true, reason: "<reason>\n<redirect>" }`. The call's input is
deep-frozen before it is translated, so nothing can change what is judged:
a later handler or tool that tries throws, and pi blocks the call.

Shell commands are read here, in the host adapter (ADR 2026-020): the
adapter is trusted code, and the model's tool input is what it reads and
the core judges. `bounded(root)` passes the composition root's one
`shellCommandReading` of the process (`openShellCommandReading()`, from
`bounded-shell-command-reader/shell-command-reading`, built into bounded as
`bounded/shell-command-reader`) as the extension's required
`readShellCommand`. Each `session_start` starts its `prepare()` without
waiting. On `tool_call`, reading the call's shell commands (each from the
project's root and the session's directory) and deciding share the
decision's 3 s deadline; a command the reader cannot read carries an
unread reading saying why, which the protected-paths pack refuses. pi's
`powershell` commands are read as bash. The grammar normally loads at
session start; a call made while it still loads waits for it (up to 5 s)
and is blocked only if loading outruns the 3 s deadline. A preparation that
never settles is waited on once: later calls do not wait for it, and the
next session start prepares again; while bounded's reader's grammar load
still hangs, each shell call is read unread (timed out) within 2 s and
refused.

`composeProject` opens the project with the core's `openProject(root, { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()] })` (every port of the protected-paths pack, from `bounded/protected-paths/adapters`, and of the prerequisites pack, from `bounded/prereqs/adapters`);
`decide` is its judge, which decides each tool use with the composed packs
and records the decision in `<root>/.bounded/log.jsonl`. A
configuration that cannot be used gives a judge that refuses every event, so
every call is blocked with the core's reason and redirect. The composition
root also guards itself: if opening the project rejects, or the judge
rejects or throws, the event is refused, and the call blocked, saying why.
The decide also carries the project's `afterTool` and `refuse`:

- Each tool use carries pi's `toolCallId` as its `callId`.
- A block the extension makes itself once the project is composed (an
  unreadable event or context, an untranslatable call, the deadline, a
  decision that is not a verdict) is handed to `refuse`, which records it as
  an `"adapter"` decision. It is not awaited, so it never delays or changes
  the block. Blocks before the project is composed cannot be recorded: there
  is no project log yet.
- On `tool_result` the finished call becomes the core's `ToolResult`
  (translated as for `tool_call`, its shell commands read again, under the
  deadline, so a result's reading may differ from the call's; one that
  cannot be translated is an
  `invoke` of its tool name; `ok` is `!isError`) and `afterTool` undoes what a
  shell command changed in watched files (see [drift.md](drift.md)). A
  subagent call's result says, per delegate effect, what bounded knows of
  its run (`delegatedAgentRuns`; see "A delegated run's finish"). What it
  undid is appended to the result's content as text and the result is marked
  as an error, so the agent sees it; nothing undone leaves the result alone.
  A check that fails or runs past the deadline is appended the same way, and
  recorded through `refuse`.

The decide also carries the project's `recordAgentRunFinish` (ADR 2026-025),
which the extension calls with each finish pi-subagents reports.

### A delegated run's finish

pi-subagents (0.52.1) runs a `subagent` call in the background unless it
says `async: false`. The adapter learns when a run finished from what
pi-subagents itself reports ([ADR 2026-028](adr/2026-028-pi-agent-run-finish.md)),
so a `bounded/prereqs` requirement can be met on pi under the same rules as
on Claude Code. The payloads were derived from pi-subagents' source, not
captured; the fixtures in `src/hosts/pi/test/fixtures/pi-subagents/` cite
the lines they follow.

- **Pairing.** A result is paired with a run only when its call has exactly
  one delegate effect and is not a resume; otherwise every entry is
  `{ finished: false, finishNeverReported: true }`, and the pack says no
  run of the agent can meet the requirement.
- **An async launch** (`details` with an `asyncId`) is
  `{ finished: false, agentRunId: <asyncId>, finishReportedLater: true }`
  only when `isError` is not true, `details.mode` is `"workflow"`,
  `details.toolCallId` is the event's call id, `details.results` is empty,
  the `asyncId` is a valid run id, and the extension subscribed on pi's
  event bus. Anything else is `finishNeverReported`.
- **A synchronous result** is `{ finished: true, resolvedAgent }` (the
  child's `agent`) when `isError` is not true and `details.results` has one
  child that exited 0 with none of `interrupted`, `detached`, `timedOut`,
  `stopped`, `turnBudgetExceeded`; `{ finished: false }` when that child
  stopped early; and `finishNeverReported` when `details` cannot be read.
- **The completion.** At load the extension subscribes once to
  `subagent:async-complete` on `pi.events`, pi's shared event bus (pi
  removes the subscription on a reload or session replacement). Each
  payload is read when it arrives, before any await, and sent to
  `recordAgentRunFinish` as `{ kind: "agent-run-finished", role: null,
  agent, agentRunId, ranToEnd }`: the agent of its one child, its `runId`
  (each null when it is not text, which the core records as unreadable),
  and `ranToEnd` true only when its `state` is `"complete"` and `success`
  true, and its child's `success` true and `status` `"completed"`, with no
  flag saying the run or the child stopped early. A completion that does not
  name exactly one child sends nothing. It is dropped before `session_start`
  or when composing failed, and a failure to record it is swallowed (pi
  does not await bus handlers). On a pi without `pi.events`, async launches
  say `finishNeverReported`, and synchronous results still count.
- **A resume** is tied or refused as described under the subagent tool; a
  tied resume's result is `finishNeverReported`, and never ties a later
  resume.

`end-to-end.test.ts` runs this with a real `bounded.config.ts`; the other
tests inject their own `load`. `piLoader()` is pure: the caller writes the
file.

`bounded init` and `bounded update` write it for you (README,
"Installing"). They run the installer bounded carries for pi
(`bounded/hosts/pi/host-installer`, from `src/hosts/pi/host-installer.ts`;
[ADR 2026-015](adr/2026-015-host-installers.md)) when pi is named or `.pi/`
exists, and it writes the loader only when the project has `.pi/`. It rewrites a
loader that differs and leaves one that cannot be read alone, refusing.

## Trust and residual risks

- **The main trust gap of pi completion: a completion can be forged from a
  file. Anything running as the user, the guarded agent's own shell
  included, can write a result file in pi-subagents' results directory under
  the OS temp directory, and pi-subagents then reports it as a completion.
  On pi this can count a pending review early.** pi-subagents accepts any
  result file whose `sessionId` and `completionOwnerId` match the session,
  both written in the run's `status.json`, and the directory is outside the
  project, so the protected-paths pack does not guard it. A forged
  completion must name a run bounded launched and is waiting on, as the
  required agent, and counts only over files unchanged since that launch.
  Nothing in pi or pi-subagents authenticates a completion (ADR 2026-028).
- **An interrupted async run counts.** pi-subagents reports it as a
  success. Another extension can interrupt a run through pi-subagents' RPC
  `interrupt` method, and possibly the user can; the guarded agent cannot,
  as bounded refuses the `interrupt` action. A synchronous result keeps the
  interrupt, so it does not count.
- **Discovery.** pi discovers project extensions only in
  `<session cwd>/.pi/extensions`, and only for a trusted project: an
  untrusted project, or `pi -ne` (no extensions), runs without bounded. A
  session started in a subdirectory does not find the project's loader.
- **Other extensions.** Global (user) extensions run after project ones
  and could mutate `event.input`; the deep freeze turns such a change into
  a blocked call (and makes a tool that mutates its own arguments fail), but an extension that runs before bounded, or that does
  its own I/O, is outside what bounded can see.
- **Parallel tool batches.** pi prepares every call of an assistant
  message (running `tool_call` handlers) before executing any of them, then
  executes the allowed ones concurrently. A check made at preparation can
  be stale at execution: one call in a batch can create the link or file
  that another, already judged, then uses. Guarded projects should run
  tools sequentially (pi-agent-core's `toolExecution: "sequential"`; pi
  0.87.1 does not expose it as a setting, so this needs an SDK host or a
  later pi option).
- **Check, then use.** Even sequentially, the file system can change
  between the check and pi's own resolution of the path.
