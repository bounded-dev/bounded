# bounded/prereqs: an action needs a prerequisite

A pack shipped in `bounded` 3.2.0 ([ADR 2026-019](../../../../../docs/adr/2026-019-prereqs-pack.md)).
A rule says that before an action, a delegation to an agent must have
succeeded over files that have not changed since. It is not a phase or a
state machine, and there is no "mark done" tool: the agent never claims
anything; the harness observes.

## Rules

```ts
// bounded.config.ts
import { contribution, defineConfig } from "bounded/domain";
import { pathGate } from "bounded/path-gate";
import { prereqs } from "bounded/prereqs";

// Each pack brings in the core it depends on (ADR 2026-018).
export default defineConfig({
  packs: [pathGate, prereqs],
  contributes: [
    contribution(prereqs.points.rules, [
      { before: { delegate: "builder" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan" },
      { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" },
      { before: { delegate: "test-writer" }, require: { delegate: "spec-reviewer", succeeded: true }, unchangedSince: ["spec.md", "src/**/*.contract.ts"], redirect: "Have spec-reviewer review the current spec and contracts" },
      // Not yet: `before: { execute }` does not compile, and is refused at composition.
      // { before: { execute: "terraform apply" }, require: { delegate: "infra-reviewer", succeeded: true }, unchangedSince: ["infra/**"], redirect: "Have infra-reviewer review the current infra/ changes" },
    ]),
  ],
});
```

- `before` is one action: `{ delegate: <agent> }` (a delegation to that
  agent in any spelling: ignoring case and surrounding spaces, since a host
  may resolve another spelling to the same agent) or `{ write: <pattern> }`
  (a file tool's write to a path the pattern matches).
- `require` is a delegation to an agent, by its exact name, that succeeded:
  a run under another spelling does not count. A rule cannot require the
  action it comes before, in any spelling.
- `unchangedSince` names the files the run must have seen as they are now.
  Patterns are checked as the path gate's, and matched as its `match`:
  ignoring case, seeing dotfiles; a pattern without a glob covers everything
  under it. Gitignored files count, but `.bounded`, `node_modules` and
  `.git` are never fingerprinted, so a pattern leading into any of them is
  refused.
- A `before.write` pattern matches a write exactly as the path gate's
  `match` does, with nothing excluded: a rule over `node_modules/**` or
  `.git/**` comes before writes there. One inside `.bounded` is refused.
- `redirect` is what the agent is told to do instead.

Rules with the same requirement (agent and patterns) share records: one
review of the plan meets both plan-reviewer rules above.

## What it observes

- **Before a call:** an action a rule comes before is refused unless a
  record of its requirement has the fingerprint its files have now. Refusals
  begin `bounded/prereqs.rules:`, name the contributing pack and the rule,
  and carry its redirect. The first rule that does not hold, in contribution
  order, refuses.
- **A delegation a rule requires** has its files fingerprinted as it starts.
  It is refused when it runs isolated (on a separate copy of the files, such
  as a worktree), when the host will not report its finish (a Claude Code
  teammate, any pi run that does not say `async: false`), or when it has no
  call id.
- **After it: only a run the host says finished counts.** The run is
  recorded when the host says it finished, it succeeded, and the files'
  fingerprint is the one taken at the start. Otherwise nothing is recorded,
  and the agent is told why.

In interactive Claude Code, fork mode runs every subagent in the background,
and a background run returns at launch: it is never seen to finish. Until
the pack observes the finish itself, disable background subagents
(`CLAUDE_CODE_FORK_SUBAGENT=0` or `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`)
for a requirement to be met. A run stopped at its turn limit is not finished
either.

**On pi, a requirement cannot be met yet.** pi-subagents 0.52.1 runs a
`subagent` call in the background unless it says `async: false`
(`asyncByDefault` defaults to true, `src/extension/config.ts:150-151`), and
even then its `forceTopLevelAsync` setting can run it in the background
(`src/runs/background/top-level-async.ts:7-14`), and a timed-out child may
leave `isError` unset (`src/runs/foreground/subagent-executor.ts:3544`). So
a delegation without `async: false` is refused, and no pi result is counted
as finished: the agent is told that the host does not report when the agent
finishes, so it cannot meet the requirement yet. This holds until the pack observes pi-subagents' completion (ADR 2026-019,
"Future work").

## What it cannot see

- **A reviewer's verdict.** "Succeeded" is the tool result's `ok`, not what
  the reviewer concluded.
- **Cycles across rules**, which make an action unreachable.
- **Shell writes:** `before: { write }` matches file tools only; a shell
  command writing under `src/` is not matched.
- **Patterns that match no file:** such a requirement can never be met, and
  says so.
- **Symbolic links:** a link is never followed. A link to a directory the
  patterns could reach into, or a link whose own path the patterns match (to
  a file, or dangling), makes the rule refuse, naming the link; replace it
  with the files, or leave it out of the patterns. Any other link is
  ignored.
- **Special files:** a FIFO, socket or device the patterns match makes the
  rule refuse, naming it (failing closed); one they do not match is
  ignored.
- **ABA:** files edited and put back between the delegation and its result
  compare equal, so the run counts.

Keep review logs and other files a run writes out of the patterns it is
fingerprinted over, or every run changes its own files and never counts.

## Records

Records are in the project, in `.bounded/prereqs/records.jsonl` (one line
per recorded run, never compacted), and per project root: a second checkout
starts with none. The starts of delegations awaiting their result are in
`.bounded/prereqs/started/calls/`, kept for a day. The guard log keeps an
audit record of each recorded run.

## The protection it relies on

The guarantee rests on the path gate keeping agents off:

- `.bounded/**`, where the records are (in `bounded init`'s default rules);
- the project's agent definitions, which say who an agent is:
  `.claude/agents/**` for Claude Code, and pi-subagents' project agent
  directory for pi.

Agent definitions outside the project (`~/.claude/agents/`, pi's user-level
agents) cannot be protected. The pack does not check any of this when it
composes.

## Ports

A host provides both, through `openProject(root, { ports:
[...pathGatePortProvisions(), ...prereqsPortProvisions()], shellCommandReader })`; the hooks for
Claude Code and pi that `bounded` carries do.

- `fileSetFingerprints` (`FileSetFingerprints`): the fingerprint of the
  files a list of patterns names.
- `prerequisiteRecords` (`PrerequisiteRecords`): the records, and the starts
  kept by call id.
