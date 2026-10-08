# 2026-019: The prerequisites pack, `bounded/prereqs`: an action needs a delegation that succeeded over unchanged files

**Status:** accepted (the maintainer's brief and decisions, two plan reviews,
and a plan amendment from captured Claude Code payloads). Ships in `bounded` 3.2.0,
with ADR 2026-018. Amends ADR 2026-006: a delegate effect carries
call-side facts, and a tool result carries result-side facts about the runs
its delegate effects started.

## Decision

### The pack

- **`bounded/prereqs`, an ordinary pack shipped in `bounded`** (as the path
  gate, ADR 2026-009), exported as `bounded/prereqs`, with its adapters at
  `bounded/prereqs/adapters` (internal, as ADR 2026-017's). It depends on the
  core pack, declares one point, `rules`, ships no rules of its own, and
  contributes one `beforeTool` and one `afterTool` check.
- **A rule** is the wire form

  ```ts
  { before: { delegate: string } | { write: string },
    require: { delegate: string, succeeded: true },
    unchangedSince: [string, ...string[]],
    redirect: string }
  ```

  Before the action, a delegation to the required agent must have succeeded
  over the files `unchangedSince` names, as they are now. It is not a phase
  or a state machine, and there is no "mark done" tool: the agent never
  claims anything; the harness observes. `before` is pinned so exactly one
  of `delegate` and `write` compiles; `before: { execute }` is refused at
  compile time and by parse (not matched yet); `redirect`, not `fix`, as in
  every Bounded refusal. A rule requiring the action it comes before is
  refused; cycles across rules are not detected.
- **Patterns are checked as the path gate checks its patterns** (repeated in
  the pack's `domain/file-set.ts`, since a shipped pack never imports
  another), and a pattern inside `.bounded` is refused.
- **`before.write` matches a write exactly as the path gate's `match`
  does:** ignoring case, seeing dotfiles, a glob-free pattern covering
  everything under it, and nothing excluded, so a rule over
  `node_modules/**` or `.git/**` comes before writes there.
- **`unchangedSince` is fingerprinted with the same matching, but the
  fingerprint never reads `.bounded`, `node_modules` or `.git`, at any
  depth** (it does read gitignored files). So an `unchangedSince` pattern
  leading into `node_modules` or `.git` (`.git/config`, `node_modules/x/**`)
  is refused at parse, naming the field and why, as one inside `.bounded`
  is.
- **Checks run around the tool call, not as effect guards.** Guards are
  synchronous and cannot await a port (ADR 2026-013); the pack's work needs
  its two ports. Its `beforeTool` refusals are recorded with
  `refusedBy: null`, as every `beforeTool` refusal is today.

### When a rule holds

- **Before a call.** For each effect a rule comes before, in contribution
  order, the rule's files are fingerprinted and compared with the records of
  its requirement (the agent by its exact name, case-sensitively, as hosts find agents; patterns in any order): equal to
  one, it holds; records only over other fingerprints, it is stale; none, it
  is missing. Files that match nothing make a requirement unsatisfiable. The
  first rule that does not hold refuses, beginning `bounded/prereqs.rules:`,
  naming the contributing pack and the rule, with the rule's redirect.
- **A delegation some rule requires** is refused at the call when it is
  isolated ("Run <agent> without isolation, on the project's own files": a
  worktree branches from the default branch, so the agent would review other
  files), when its finish goes unreported ("Run <agent> as a run whose
  finish the host reports (not as a teammate or an asynchronous run)"), or
  when it has no call id. Otherwise each requirement it can meet has its
  files fingerprinted, and these starts are kept under the call's id.
- **After the call, only a run the host says finished counts (a positive
  marker).** A delegation's result is recorded when the host says that
  agent's run finished, the result is `ok`, and the fingerprint now equals
  the one kept at the start. A result that does not say so records nothing,
  and the agent is told: "bounded/prereqs.rules: <agent>'s run was not seen
  to finish (it may still be running in the background), so it is not
  recorded; run <agent> so that the host reports its finish". This fails
  closed for every early-return form, known or not. A missing or altered
  start, files changed during the run, or a record that cannot be written
  record nothing and say so; the last two that are failures are recorded in
  the guard log as refusals naming the pack.
- **Fail closed.** A fingerprint that cannot be computed, records that cannot
  be read (a malformed record line included), or a missing port refuse with
  an actionable message.

### Which side carries what (amends ADR 2026-006)

- **The call side stays on `DelegateEffect`:** `isolated?: true` (the agent
  works on a separate copy of the project's files) and `finishUnreported?:
  true` (the host will not report when this run finishes). Optional on the
  wire, refused when not boolean, and written by `toJSON` only when true, so
  stored data keeps its shape.
- **The result side is on `ToolResult`:** `delegatedAgentRuns?: { finished:
  boolean }[]`, one entry per delegate effect in the effects' order.
  `ToolResult.parse` refuses a list whose length differs from the number of
  delegate effects ("…: 2 effects, 1 entry"), and a list on a result with no
  delegate effect. Absent means no run is said to have finished; `toJSON`
  writes it only when given.

### The hosts' mappings

- **Claude Code, on calls:** `isolation: "worktree"` sets `isolated` (any
  other isolation is refused); a teammate spawn (`name` without `isolation`)
  sets `finishUnreported`. `team_name` is not relied on. `run_in_background`
  is not read: in fork mode it does not say what happens.
- **Claude Code, on results:** an Agent or Task result's one entry is
  finished only when `tool_response.status` is `"completed"` **and**
  `harnessNoteCount` is a number equal to 0. Captured from Claude Code
  2.1.294: a foreground run reports `completed` with `harnessNoteCount: 0`;
  a background run reports `async_launched` (with `isAsync: true`), and a run
  is background when `run_in_background` is absent, even under `-p`; a run
  stopped at its turn limit (`maxTurns`) also reports `completed`, but with
  `harnessNoteCount: 1` and a note that it stopped before finishing. So a
  missing or non-numeric count, a count above 0, or any other status is not
  finished. The content text is never matched. PostToolUseFailure is never
  finished.
- **pi:** every delegate effect of a `subagent` call is `finishUnreported`
  unless the call says `async: false`, and no result marks a run finished,
  not even one with `async: false`; an `async` that is not a boolean is
  refused. From pi-subagents 0.52.1's source: a call without `async` runs in the
  background, since `asyncByDefault` defaults to true
  (`src/extension/config.ts:150-151`, `return config.asyncByDefault !==
  false;`; `src/extension/schemas.ts:318`); even `async: false` is turned
  into a background run at the top level when the configuration sets
  `forceTopLevelAsync` (`src/runs/background/top-level-async.ts:7-14`); and
  a timed-out child is marked `timedOut`
  (`src/runs/foreground/execution.ts:469`) while the executor counts a run
  failed when `isError === true` or any child's `exitCode !== 0`
  (`src/runs/foreground/subagent-executor.ts:3544`), so a timed-out child
  may leave `isError` unset.
  The call cannot say whether its agents run to their end, and the result
  cannot say so either. **So on pi a requirement cannot be met until item
  1c** (`prereqs-pi-async`, observing pi-subagents' completion).

### Why not refuse background runs

The first plan refused a background start of a required agent. Claude Code
runs every interactive subagent in the background by default since v2.1.232
(fork mode), a foreground run can be sent to the background with Ctrl+B, and
an agent's frontmatter can ask for `background`. A refusal keyed on the call
would refuse almost everything and still miss the forms it cannot see. A
positive marker on the result counts exactly the runs seen to end.

### Records

- **In a pack store, in the project.** Records are
  `<root>/.bounded/prereqs/records.jsonl`, content-addressed (a record holds
  the fingerprint it was made over, so files put back as reviewed hold
  again), per project root, and never compacted. Each is appended as one
  whole line in one write to a file opened for appending; a torn last line
  is ignored, and the next append ends it with a marker so it stays ignored.
  Starts are `<root>/.bounded/prereqs/started/calls/<sha256 of the call
  id>.json`, written whole (a temporary file renamed), kept a day and swept
  on save. The guard log keeps an audit record of each recorded run.
- **The two ports**, each with an adapter, an in-memory double and a
  conformance suite: `FileSetFingerprints` (`FileSystemFileSetFingerprints`:
  a walk of only the directories a pattern's fixed leading path can lead to,
  hashing each matching file's path and bytes) and
  `PrerequisiteRecords` (`FileSystemPrerequisiteRecords`). Hosts pass
  `[...pathGatePortProvisions(), ...prereqsPortProvisions()]`.
- **Fingerprint time.** Fingerprinting 2,000 files takes well under pi's
  3,000 ms deadline; the adapter's test requires a median under 1,000 ms and
  prints it.

### What the guarantee rests on

No compose-time protection check. The docs state what the pack relies on:
the path gate protecting `.bounded/**` (records; in `bounded init`'s
defaults) and the project's agent definitions (`.claude/agents/**`,
pi-subagents' project agent directory), which give role identity.

## Limits

- **Interim, until the finish event lands:** in interactive Claude Code,
  where fork mode runs every subagent in the background, a requirement can
  be met only with background subagents disabled
  (`CLAUDE_CODE_FORK_SUBAGENT=0` or `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`).
- **On pi, no requirement can be met until item 1c:** no pi run is marked
  finished (see "The hosts' mappings").
- **A symbolic link the patterns match, or a linked directory they could
  reach into, makes the fingerprint fail**, naming the link: a link's
  target is never fingerprinted, so the rule refuses until the link is
  replaced by files or left out of the patterns.
- `before.write` matches file tools' writes only, not writes a shell command
  makes.
- **ABA:** files edited and restored between the delegation and its result
  compare equal, so the run counts.
- Records are per project root; teammates and isolated runs of a required
  agent are refused.
- Agent definitions outside the project (`~/.claude/agents/`, pi's
  user-level agents) cannot be protected by the path gate.

## Future work

- **`prereqs-run-finish`:** a host-neutral finish event, named for an agent
  run with no reference to delegation (so a top-level session started as an
  agent can become a source later without changing it), with a run id on
  `delegatedAgentRuns` entries, a per-run start store and a `pending` status
  ("started at T; wait for its finish"). It amends ADR 2026-005 and ADR
  2026-008, and is gated on a capture of Claude Code's SubagentStop payloads.
- **`prereqs-pi-async`:** pi-subagents' asynchronous completion, mapped to
  that event.
- **`before: { execute }`** and shell writes, once shell commands are parsed
  for it.
- **A status widget** for Claude Code, listing each rule's requirement as
  holds, stale or missing, derived from the same records.

## Consequences

- The core gains two optional call-side flags on the delegate effect and an
  optional result-side list on a tool result; no other event changes, and
  stored data without them reads as before.
- A project selecting `bounded/prereqs` must be opened with its ports, or
  every event is refused naming `bounded/prereqs` and `fileSetFingerprints`.
