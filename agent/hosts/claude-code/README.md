# Claude Code host adapter

The developer stage's **capability constraints** (ADR 2026-034, Tier B) for
Claude Code: the path gate and the phase gate as a `PreToolUse` hook, the tool
strip as generated `.claude/agents/*.md` `tools:` allowlists, and the role
binding through each agent definition's own `hooks:`. The **artifact gates**
(Tier A) are not here — they are `bounded gates <gate>`, one CLI for every host,
and this adapter only decides who may run which of them.

Everything here is thin wiring over the same pure cores the pi extensions
use: `decide()` (`src/path-policy.ts`), `checkSubagentCall()`
(`src/phase-gate.ts`), `sessionRole()` (`src/path-gate.ts`). There is no second
rule set. Where Claude Code differs from pi — it has no way to register a named
tool, so the gates are reached through Bash — the difference is one derived
list (`bash-policy.ts`) and one mapping (`PI_TO_CLAUDE_TOOLS` in
`render-agents.ts`), both pinned to `ROLE_TOOLS` by drift tests.

**Status: the developer stage has been exercised; the new lead entry has not
yet had a live run.** Fixture tests spawn the existing pipeline hook and
installer against Claude Code hook payloads. Live developer-stage
runs delivered in [Run 25](../../../docs/dogfood/runs/run-26-025-the-first-claude-code-harness-run.md),
[Run 27](../../../docs/dogfood/runs/run-26-027-opus-vs-kimi-both-harnessed.md), and
[Run 29](../../../docs/dogfood/runs/run-26-029-non-technical-ui-service-persistence.md).
Run 29 also exposed missing shared-service delivery despite green gates;
completing the host workflow does not establish application completeness.
The lead-to-nested-architect path is implemented from documented Claude Code
capabilities and still needs a live run before its behavior can be claimed.

## Files

| file | what |
|---|---|
| `bootstrap-hook.ts` | Dependency-free project entry. Until setup completion and both dependency trees are present it admits exact setup at the project root and confines local reads to that project; afterward it invokes the full hook. |
| `path-gate-hook.ts` | The `PreToolUse` hook. Reads the call as JSON on stdin; prints a deny decision, a rewritten local command, or nothing. `--role <role>` binds a subagent. A project-local main session defaults to the read-only lead; the global installer retains the legacy `.bounded/dev-stage-role` fallback. |
| `tool-map.ts` | Claude Code tool call → pi tool call(s): `Read {file_path}` → `read {path}`, `Agent {subagent_type}` → `subagent {agent}`, and so on. |
| `bash-policy.ts` | What a role may put through Bash: `bounded gates <gate>` for the gates in its `ROLE_TOOLS`, plus `git`, `sleep`, `rm <path>`, `ls` and `find` where the role holds the pi tool. Everything else refused. |
| `listing.ts` | The names-only `ls` / `find` grammar every role, the lead and the scout list files with. |
| `continuation.ts` | How a finished worker is continued here: `SendMessage` to a recorded worker, and the records that license a relaunch. |
| `render-agents.ts` | Generates `.claude/agents/<role>.md` from `agents/<role>.md`: `tools:` from `ROLE_TOOLS`, `hooks:` binding the role, the pi brief verbatim under a host preamble. |
| `project-install.ts` | Adds the read-only scout, team-lead skill, and main-session lead instructions to an initialized project. |
| `install.ts` | Writes the four developer-stage agents, links the `developer-stage` skill into `.claude/skills/`, and merges the ambient hook into `.claude/settings.json`. |

## What it enforces

- **Path gate**, identical to pi's: Read/Edit/Write/MultiEdit/NotebookEdit/
  Glob/Grep are mapped to `read`/`edit`/`write`/`find`/`grep` and judged by
  `decide()` against the role's zones. A blind role cannot read the other
  side's work product; every role's writes are confined to its zone; `.git`
  and `.bounded` are protected as in pi.
- **Model tiers** (ADR 2026-022), planned by the same core as pi's
  (`planModelTier` over `.bounded/dev-stage-models.json`): an allowed spawn of a
  pipeline role is rewritten to the seat's tier, translated into the Agent
  tool's vocabulary (`anthropic/claude-opus-5:high` → `opus`), and a
  caller-passed model is replaced, loudly, in the guard log. A configured
  tier this host cannot run (a non-anthropic model) refuses the spawn
  rather than quietly seating the session default.
- **Phase gate** on `Agent`: an `Agent` call with `subagent_type: builder` is
  a `subagent` launch of the builder, judged by `checkSubagentCall()` against
  the project's guard log — no contracts, no spec, no design gate, no spawn.
  Before that, the `subagent_type` itself is judged: only the four generated
  definitions carry a tool strip and a bound hook, so a commission of
  anything else — `general-purpose`, `Explore`, a user's own agent, pi's
  `delegate`, or no `subagent_type` at all — is refused as an unbound
  subagent, in the phase gate's own words, and logged as its
  `spawn-refused` block. Without this, `Agent {subagent_type:
  "general-purpose"}` would be a full-toolset, hook-free proxy for the
  architect, which is exactly what pi's `delegate` refusal prevents.
- **A bounce continues the worker that already ran** (`continuation.ts`). The
  core refuses a second cold launch of a role; on this host the way to
  continue a finished subagent is `SendMessage` to the agent id its Agent
  result reported. With background tasks disabled the send resumes the
  subagent in the foreground and returns its reply; the resumed subagent runs
  under its own definition again, so its own hook and `tools:` still bind it
  (verified live on Claude Code 2.1.286). The architect's definition also runs
  the hook after `Agent` and `SendMessage` (`PostToolUse`,
  `PostToolUseFailure`): that records each worker's agent id in the guard log,
  and `SendMessage` is allowed only to a role's current recorded worker —
  never `main`, another session, or a replaced worker. A fresh launch of a
  role is licensed only by positive evidence: a failed continuation of its
  current worker, a launch that failed or reported a terminal non-completed
  status, an after-call hook that errored on the launch, or a launch with no
  recorded outcome made before an architect turn whose end the launch wrapper
  recorded in the ticket worktree's guard log (a different agent id alone is
  never evidence). No architect may commission another, and each ticket
  worktree runs one architect turn at a time (ADR 2026-066). A
  launch still running — including a background one, recorded from its
  `async_launched` id — licenses nothing. The architect's Agent calls are held
  to the lead's field allowlist, so `run_in_background`, `isolation` and
  `name` are refused.
- **Tool strip**, as `tools:` in the generated agent definitions: a worker
  never sees `Agent` or `SendMessage`; the reviewer never sees `Write` or
  `Edit`. Pinned to `ROLE_TOOLS` by `render-agents.test.ts`, the way
  `agent-config-drift.test.ts` pins pi's frontmatter. Every tool a definition
  names must be one Claude Code provides to every subagent
  (`CLAUDE_PROVIDED_TOOLS` in `tool-map.ts`). Glob and Grep are not: native
  builds drop them in favour of `find` and `grep` through Bash unless the
  session is launched naming them, and a subagent's `tools:` line does not
  bring them back. So file names are listed with `ls` and `find` through Bash
  (`listing.ts`): a small names-only grammar, judged as pi's own `ls` and
  `find` by `decide()`. Content search is `grep` through Bash (`search.ts`):
  one pattern, one path, an optional `--include` glob, judged as pi's own
  `grep` — a blind role's directory search needs a glob that provably keeps
  it off the other side (ADR 2026-057). The grammar refuses every option the
  bundled grep would hand to the system grep, so an allowed search always runs
  on Claude Code's bundled ugrep.
- **Bash narrowed to the carriers.** The command is read the way a POSIX
  shell reads it and refused if it is more than one plain argv: `;`, `&`,
  `|`, `(`, redirects, `$`, backticks, backslashes, globs, braces, tilde,
  comments, an unterminated quote, an env-assignment prefix. What survives is
  allowed only if it is one of:
  - `bounded gates <gate> …` where `<gate>` (hyphens or underscores) is in the
    role's `ROLE_TOOLS` and is not a file tool — so the builder may run
    `run-tests` and `typecheck`, the architect every gate, the reviewer
    `record-design-review` and `typecheck`; `bounded gates --list|--help` always;
  - read-only `git …` for roles holding `git` (the architect), as defined by
    the shared Git policy. The subcommand is the first word
    after the four global options the policy passes (`--no-pager`, `-P`,
    `--no-optional-locks`, `--literal-pathspecs`); any other leading option
    is refused by name, because a global that takes a value (`-C <dir>`,
    `--git-dir <dir>`) would put its value where the subcommand is read and
    slip `config core.hooksPath …` or `bisect run …` past the checks;
  - `sleep <1-120>` for roles holding `sleep` (the architect);
  - `rm <one literal path>` judged as a pi `remove`, so the write zones apply.
  A refusal is one line: `path-gate: <role> may not run '<cmd>': <why> — …`,
  using pi's own `forbiddenWhy` sentence where pi has one. `--role` and
  `--findings-file` are refused anywhere in a `bounded gates` argv: the host
  supplies the role, and findings are passed inline. Gate names are
  hyphenated (`bounded gates red-gate`); the pi spelling (`red_gate`) is accepted.
- **The bound role, the host and the call's deadline reach the gate
  process.** An allowed `bounded gates …` is answered with
  `permissionDecision: "allow"` and an `updatedInput` whose command is
  `BOUNDED_HOST=claude-code BOUNDED_DEV_STAGE_ROLE=<role>
  BOUNDED_COMMAND_TIMEOUT_MS=<ms> <original command>`; the rest of the tool
  input, the call's own `timeout` included, is kept. The deadline is that
  `timeout` (Claude Code's default when the call names none, capped at its
  maximum: 2 and 10 minutes, or `BASH_DEFAULT_TIMEOUT_MS` and
  `BASH_MAX_TIMEOUT_MS` when Claude Code's environment sets them): Claude Code kills the command past it, so a gate
  that can split its work across calls (`mutation-score`) stops before it
  (ADR 2026-070). `sessionRole()`
  reads the role variable before the `.bounded/dev-stage-role` file, so a gate
  that scopes its output by role (`typecheck`) sees the role the definition
  bound, whatever file the project holds; and the CLI records `host
  claude-code` in the guard log rather than `host none`, which is what a
  `bounded gates` with no `BOUNDED_HOST` records. The policy has already refused every
  construct that could make the prefix anything but an env assignment, and a
  prefix the model types itself — any of the variables — is refused. `git`,
  `sleep` and `rm` are allowed silently — nothing in them reads a role.
- **Role binding by which definition loads.** `.claude/agents/<role>.md`
  carries the hook with `--role <role>` in its own `hooks:`; those fire only
  inside that subagent. The model cannot change its role: `.claude/**` is in
  no role's write zone, so the definitions and `settings.json` are unwritable
  from inside a run.
- **Guard log.** Every block, the run-start marker (the architect's first
  call, once — the log is the latch, since each hook run is a fresh process),
  and every hook error land in `<project>/.bounded/guard-log.jsonl`, the same file
  and the same event shapes pi writes.
- **Fails open only for local reads — loudly either way.** Malformed
  stdin, an unreadable project, a bug: one line goes to stderr and an `error`
  event goes to the guard log. Then only `Read`, `Grep`, `Glob` and `LS` are
  allowed; every other call — writes, Bash, agents, MCP tools, skills, an
  unknown tool, or a payload too broken to name one — is denied with a
  reason that says the hook errored. A hook that could brick a session would
  be disabled, and a disabled gate is worse than a visible gap — but a gate
  that waves an unjudged call through on its own error is not a gate.

## What it does not enforce (honest limits)

- **The tier's thinking level.** The model tier is enforced (see above), but
  a pattern's `:high`-style thinking suffix has no Agent-tool equivalent
  here and is dropped; the guard line shows the full pattern so the loss is
  visible. The phase gate's tier-resolvability check still runs without a
  registry snapshot (⇒ "cannot tell", never a refusal), exactly as in pi —
  the host's own runnability check replaces it at spawn time.
- **Role-scoped views are the CLI's to apply.** The hook hands the bound
  role to the gate process (`BOUNDED_DEV_STAGE_ROLE`), and the registry's
  `typecheck` entry resolves `sessionRole(cwd)` when no `--role` is given —
  so the builder's `bounded gates typecheck` is scoped exactly as pi's `typecheck`
  tool is. What the hook still cannot do is see or edit a gate's OUTPUT:
  a gate that prints something role-sensitive without consulting the role
  prints it here too. `run-tests` sanitizes inside the pack script, so that
  view is the same on both hosts.
- **`bounded gates` arguments are not judged.** `bounded gates run-tests ../other`
  runs a gate against another directory and writes to that project's guard
  log. No gate echoes an arbitrary file, so this is not a read channel, but
  it is a way to act outside the project the hook was installed in.
- **Git is read-only in every host.** The architect can inspect status and
  history through the shared Git policy. Mutating commands are refused because
  they can rewrite protected files without using the file tools or their path
  gate. The Claude Bash carrier additionally refuses shell syntax and Git
  options that run external commands.
- **The main session has no tool strip.** In an initialized project, the
  ambient hook judges every main-session tool as the lead and denies unknown
  tools. In the global installer, a legacy `.bounded/dev-stage-role` still
  selects a direct role; that ambient mode cannot strip tools it does not map.
- **The project hook also sees subagent calls.** A generated subagent's own
  frontmatter hook binds its role. The project settings hook stands down when
  the `PreToolUse` payload carries `agent_id`, which identifies a child call;
  `agent_type` alone can also describe a directly launched main session.
  If `agent_id` is absent, the project hook applies the lead
  policy to the subagent too and blocks its writes. This fails closed but can
  stall the architect's loop; inspect hook payloads before claiming an end to
  end Claude Code delivery through the new entry path.
- **Lexical paths, as in pi.** The gate normalises paths without resolving
  symlinks. No role can create one (no `ln`, no shell), so the surface is the
  same as pi's.
- **`bounded gates` is resolved on PATH.** The policy accepts the bare name only,
  and no role's write zone is on a normal PATH, but a PATH that includes a
  project directory would let a role's own `bounded gates` be the one that runs.
- **`bounded gates` is auto-approved by design; everything else keeps Claude
  Code's own prompts.** An explicit `permissionDecision: "allow"` bypasses
  Claude Code's permission prompt, and an allowed `bounded gates …` is answered
  that way on purpose: the policy has already proved the argv is one plain
  command naming a gate the role holds, and the rewrite is the only way to
  hand it the role. Every other allow — `git`, `sleep`, `rm`, the file
  tools, anything unmapped — is silent (no output), so Claude Code's own
  prompts stay in place for it. A deny from the hook is final.

## Install

Requires Node 22.18+ (`node` runs `.ts` directly) and project-local Bounded
gate commands. The repository-only `agent/scripts/bounded-init` wires the
developer machine; initialized projects carry their own adapter and commands.

```sh
node <harness>/hosts/claude-code/install.ts <project>
```

Writes `<project>/.claude/agents/{scout,architect,test-writer,builder,reviewer}.md`,
copies the `team-lead` skill, and links `<harness>/skills/developer-stage` at
`<project>/.claude/skills/developer-stage` (the architect's brief opens by
loading that skill, and Claude Code reads skills from the project's
`.claude/skills/`, not from `~/.pi/agent/skills`), and adds the ambient hook
and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` plus
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0` to
`<project>/.claude/settings.json`. The latter makes each reviewer and worker
return its result to the architect before the next phase; Claude Code runs
these roles sequentially. Other settings are preserved, and a conflicting
value is refused. Idempotent; prints one line per file: `wrote`,
`unchanged`, `linked <path> -> <target>`, or — where the platform refuses a
symlink — `copied <path> (symlink refused: …)`, in which case the copy
carries a `.bounded-harness-generated` marker file and must be re-installed after
the skill changes. It refuses to overwrite an agent file that lacks the
`# generated by bounded-harness` marker, a real `.claude/skills/developer-stage`
directory that is not a symlink and lacks that marker file (someone's own
skill), and a `settings.json` it cannot parse — exit 1, nothing written.
Re-run it after editing `agents/<role>.md` or `ROLE_TOOLS`: the rendered
files are derived and carry no hand edits.

The installer writes an **absolute harness path** into `settings.json`, into
each agent file's `hooks:` command, and into the skill symlink. `.claude/` in
a pipeline project is therefore generated per machine and belongs in that
project's `.gitignore`, next to `.bounded/`; a clone re-runs the installer.

## Running a ticket

Initialized projects open the main Claude Code session, in the main
worktree, as a read-only team lead. The installer gives it the team-lead
skill and a read-only scout definition. The user states the outcome without
naming roles. The lead inspects the project, runs exact dependency setup
before the first ticket, and works through its commands (ADR 2026-066):
`bounded lead ticket create ...` creates a GitHub issue with its sections,
`bounded lead queue <issue>` queues it, and `bounded lead start <issue>`
gives it its own worktree under `.bounded/worktrees/<issue>` and branch
`ticket/<issue>`, sets it up, prepares its run and launches its architect
there. `bounded lead status` shows every started ticket, `bounded lead reply
<issue> <message>` continues an architect with the user's answer, and
`bounded lead merge <issue>` merges a delivered ticket into `main`, runs the
project's check, pushes and closes it. The lead never commissions an
architect as a subagent and does not edit product files.

The architect runs as the ticket worktree's own top-level Claude Code session
(`claude -p`, one run per turn; `architect-launch.ts`), so its working
directory, `CLAUDE_PROJECT_DIR`, hooks, path gate and `.bounded/` state are
all the worktree's. It loads only the project's settings and runs in
`dontAsk` mode with nothing pre-approved: the hook allows each call it judges
as allowed explicitly, so a session whose hook never ran can change nothing.
The launch refuses when the worktree does not register the hook, or when a
managed policy switches hooks off. The launch puts the seat in the session's environment;
the worktree's project-wide hook accepts it only in a worktree the start
command marked, judges every call as the architect, and records its Agent
and `SendMessage` outcomes. A top-level session in a ticket worktree that was
not launched that way is read-only. The architect's nested reviewer,
test-writer and builder are ordinary subagents bound by their generated
definitions, as before; they inherit the worktree as their working
directory. Project settings keep those calls in the foreground, and agent
teams remain disabled. The Claude Code [subagent
documentation](https://code.claude.com/docs/en/sub-agents) describes nested
agent and definition hook behavior.

The lead hook admits the project-local command
`bash .bounded/harness/scripts/bounded gates --list` for discovery,
`bash .bounded/harness/scripts/bounded setup` to install the project's pinned
dependencies (before the first ticket starts, or to repair a completed setup
whose dependencies are missing), and the lead's commands as
`bash .bounded/harness/scripts/bounded lead <command>` (or `bounded lead
<command>`), each one plain command validated with the commands' own parser.
Before the first ticket starts, before or after setup, it also admits
the user's own
`bounded init --host <host> --surface <id>... [--without <id>...] [--pack <name>...] [--apply <digest>]`
(with `--host claude-code`) as one plain command, unrewritten, so the lead
can re-plan a capability selection the spec showed was wrong. Init replaces
the installation only while it is untouched (ADR 2026-065); setup then runs
again.
It refuses arbitrary Bash and file edits even when an old
`.bounded/dev-stage-role` names an architect, and it refuses every architect
commission: an architect starts only through `bounded lead start <issue>`.

The generated scout definition binds its own hook with `--role scout`, which
holds it to project reads (Read, and `ls` / `find` through Bash) and nothing else. Any other
subagent the project hook cannot prove is bound by its own generated
definition — a built-in agent, a forked skill, a user's own definition — is
held to that same read-only scout policy.
