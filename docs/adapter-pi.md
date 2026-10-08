# The pi host adapter (`apps/pi`, shipped in `bounded` as `bounded/hosts/pi`)

pi loads project extensions from `.pi/extensions/`. Bounded's is one: at
session start it composes the project's guards, and on every tool call it
turns pi's call into a host-neutral tool use, decides it, and answers pi.
Anything it cannot read, translate or decide in time blocks the call.

Its source is the private workspace app `apps/pi`; `bounded`'s prepack
compiles it for Node into `bounded`'s `dist/hosts/pi/`, so it is installed
with `bounded` and exported as `bounded/hosts/pi`
([ADR 2026-016](adr/2026-016-cli-app.md)). A project configures its packs in `bounded.config.ts`
([configuring a project](configuration.md)).

## Reading order (about 15 minutes)

1. `src/event.ts` — the tool use the adapter produces: the core's `ToolUse`,
   a tool kind and its effects (read, list, write, execute, fetch, delegate,
   invoke), built through the core's own `ToolUse.parse`.
2. `src/pi-path.ts` — where a path argument really acts: pi's own rewrite
   (unicode spaces to " ", one leading `@` stripped, `~` and `~/` expanded,
   `file://` decoded), resolved against the session's directory, kept inside
   the project, then followed through links (with the native realpath, so a
   case-insensitive volume yields the stored case) to where it lands. A
   dangling link or a loop of links is refused. A read is located as pi's
   read opens it, fallback spellings included. POSIX paths only.
3. `src/translate.ts` — the table from pi's tools to tool uses, and
   `src/subagent.ts`, the strict reading of the subagent tool. Pure, given
   the locator.
4. `src/extension.ts` — the extension: `session_start` composes, `tool_call`
   translates, decides and answers; every failure, and every deadline
   missed, blocks. `tool_result` checks the finished call.
5. `src/install.ts` and `src/index.ts` — the loader file a project needs, and
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
- `action: "status"` and `action: "resume"` are invoked by name
  (`subagent.status`, `subagent.resume`) with no delegate, so a guard allows
  or refuses them by name. A run directory (`dir`) they name must be inside
  the project. Every other action refuses.
- Every delegate effect is `finishUnreported` unless the call says
  `async: false` (ADR 2026-019): pi-subagents 0.52.1 runs a call without
  `async` in the background (`asyncByDefault` defaults to true,
  `src/extension/config.ts:150-151`), and pi does not report when a
  background run's agents finish. An `async` that is not true or false
  refuses the call.
- An `agentScope` other than `"project"` refuses: agents found outside the
  project are not the project's to vouch for. Deferred: when `agentScope` is
  absent, pi-subagents searches user and project agents (`"both"`); the call
  is translated, and guards see the agent's name but not where it was found.

This reading follows the shapes of pi-subagents' schema (single agent,
tasks, chain with parallel). Version 0.52.1 runs workflows through
`workflowScript`, which is JavaScript the translation cannot describe, so
such calls are refused.

## How it plugs in

```
.pi/extensions/bounded/index.ts      generated by piLoader(): an async factory
  -> import("bounded/hosts/pi")      fails closed: if this or the extension throws, every tool call is blocked
  -> bounded(root)                   src/index.ts
     -> piExtension({ projectRoot, load })  src/extension.ts; load is the composition root's seam
        -> composeProject(root)      src/composition-root.ts: openProject(root, { ports, shellCommandReader }) from bounded/open-project
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

`composeProject` opens the project with the core's `openProject(root, { ports: [...pathGatePortProvisions(), ...prereqsPortProvisions()], shellCommandReader })` (every port of the path gate, from `bounded/path-gate/adapters`, and of the prerequisites pack, from `bounded/prereqs/adapters`, and the one `TreeSitterShellCommandReader` of the process, from `bounded-shell-command-reader/adapters`, built into bounded as `bounded/shell-command-reader`, ADR 2026-020; pi's `powershell` commands are read as bash);
`decide` is its judge, which decides each tool use with the composed packs
and records the decision in `<root>/.bounded/guard-log.jsonl`. A
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
  (translated as for `tool_call`; one that cannot be translated is an
  `invoke` of its tool name; `ok` is `!isError`) and `afterTool` undoes what a
  shell command changed in watched files (see [drift.md](drift.md)). A
  subagent call's result says, per delegate effect, that its run is not
  known to have finished (`delegatedAgentRuns`, every entry `finished:
  false, finishNeverReported: true`; ADR 2026-019), even with `async: false`: pi-subagents'
  `forceTopLevelAsync` can still run it in the background
  (`src/runs/background/top-level-async.ts:7-14`), and a timed-out child may
  leave `isError` unset (`src/runs/foreground/subagent-executor.ts:3544`).
  So on pi a `bounded/prereqs` requirement cannot be met until the adapter
  observes pi-subagents' completion. What it
  undid is appended to the result's content as text and the result is marked
  as an error, so the agent sees it; nothing undone leaves the result alone.
  A check that fails or runs past the deadline is appended the same way, and
  recorded through `refuse`.

`end-to-end.test.ts` runs this with a real `bounded.config.ts`; the other
tests inject their own `load`. `piLoader()` is pure: the caller writes the
file.

`bounded init` and `bounded update` write it for you (README,
"Installing"). They run the installer bounded carries for pi
(`bounded/hosts/pi/host-installer`, from `src/host-installer.ts`;
[ADR 2026-015](adr/2026-015-host-installers.md)) when pi is named or `.pi/`
exists, and it writes the loader only when the project has `.pi/`. It rewrites a
loader that differs and leaves one that cannot be read alone, refusing.

## Trust and residual risks

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
