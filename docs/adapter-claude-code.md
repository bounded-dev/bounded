# The Claude Code adapter

`apps/claude-code` (package `bounded-claude-code`) is the host adapter for
Claude Code. Claude Code runs it before every tool call as a `PreToolUse`
hook; it turns the call into a host-neutral tool-use event, asks bounded for
a verdict and answers in Claude Code's words. It is an app: it holds no rules
of its own and imports the core only through its export paths.

## Reading order (about 10 minutes)

1. `src/translate.ts` — the hook's stdin read and checked (`readPayload`),
   then every Claude Code tool mapped to a tool kind and its effects, with
   paths still as Claude Code wrote them (`translate`). Pure.
2. `src/event.ts` — the event (`ToolUse`, `Effect`), the `PathResolver` port,
   and `toToolUse`, which resolves every path through the port.
3. `src/paths.ts` — the port's file-system adapter: how a path is judged by
   where it really lands.
4. `src/hook.ts` — one call from stdin to stdout, under a deadline, and how it
   fails closed.
5. `src/composition-root.ts`, `src/run.ts`, then `src/main.ts` — the wiring,
   the host, and the bootstrap Claude Code runs.
6. `src/install.ts` — merging the hook into `.claude/settings.json`.
7. `test/main.e2e.test.ts` — the hook run as Claude Code runs it.

## The tool map

| Claude Code tool | Tool kind | Effects |
| --- | --- | --- |
| Read, NotebookRead | read | read `file_path` / `notebook_path` |
| Write | write | write `file_path`: create if it does not exist, else modify |
| Edit | edit | write `file_path`: create if it does not exist (an empty `old_string` creates), else modify |
| MultiEdit | edit | as Edit, once per distinct path (`file_path` and any edit's own) |
| NotebookEdit | edit | write `notebook_path`: modify |
| LS | search | list root `path` |
| Glob | search | list root `path` (else the session's directory), filter `pattern` |
| Grep | search | list root `path` (else the session's directory), filter `glob`; read the root. The regex is not an effect |
| Bash, PowerShell, Monitor | shell | execute `command`, `cwd` the session's directory, project-relative |
| Agent, Task | subagent | delegate to `subagent_type` (Claude Code's default, `general-purpose`, when absent) |
| WebFetch | web | fetch `url` |
| WebSearch | web | invoke `WebSearch` |
| anything else (Skill, `mcp__*`, ...) | other | invoke the tool's name |

An invoke is a tool call whose effects cannot be described: WebSearch names
no URL, and inventing one would mislead a guard, and an unknown tool's effects
are unknown. It is never an execute, which is strictly a shell command that
gates parse as one. A project that refuses unknown capabilities does it with
one guard on `invoke`.

A search filter that is absolute or climbs with `..` (`../../out/*`,
`/etc/*`) reaches outside its root, so its fixed part (split off by
picomatch) is folded into the root, which is then resolved and judged like
any path: `{ path: "/p/src", pattern: "../../out/*" }` lists `/out` with
filter `*`. A filter that climbs after a wildcard, or a negated one that
climbs, cannot be judged and is refused.

A required field that is missing or not text refuses the call; nothing is
passed through unchecked.

## Paths

Claude Code trims a path (`String.prototype.trim`, which also strips NBSP and
U+FEFF) and expands a leading `~` before it uses it, so the adapter trims in
exactly the same way and judges the trimmed path. A path then starting with
`~`, `@` or `file:` is refused rather than expanded here, so the home
directory never stands in for a project path. Any other path is resolved
against the session's `cwd` (from the payload; the project root when absent),
and its existing components through `realpath.native`: a link is judged by
where it lands, a path that does not exist yet by its nearest existing parent
(its missing tail keeps the case it was written in; on a volume that ignores
case the existing part takes the case on disk), and a link to nothing is
refused. The result must be inside the project, whose root is
`CLAUDE_PROJECT_DIR` (never the payload's `cwd`: a session started in a
subdirectory would otherwise treat that as the root). A path written outside
the project that is a link into it is accepted, as the place it lands.
Whether the file exists also tells a Write's or Edit's create from its modify.

Limits: a hard link cannot be told from its target, so a hard link inside the
project to a file outside it is judged as inside. And the file system can
change between the check and the tool's use of the path (a link swapped in
after the hook answers); the hook judges the state it sees.

## Answers

- allow: empty stdout, exit 0. Claude Code's own permissions still apply.
- refuse: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason>\n<redirect>"}}`, exit 0.
- Empty or malformed stdin, an untranslatable call, a refused path, a
  missing `CLAUDE_PROJECT_DIR`, a decide that throws, rejects or returns no
  verdict: all refuse.
- `decide` is asynchronous (the core's judging awaits its decision log). If
  it has not settled within 20 seconds the call is refused, well inside the
  30-second `timeout` the install helper sets on the hook entry.
- Claude Code proceeds when a hook exits with anything but 0 or 2, so the
  hook never relies on its own exit code to refuse. `main.ts` is a bootstrap
  with no static imports: it loads the rest inside a `try`, so a missing
  module or a syntax error is still a deny with exit 0. When the process
  cannot start at all (bun not on `PATH`, killed for memory), the installed
  command's `|| { echo "bounded hook failed" >&2; exit 2; }` blocks the call.
- After writing its answer the hook sets `process.exitCode` and never calls
  `process.exit`: the event loop drains, so work still pending (the core's
  decision log may write a follow-up line after a late record settles)
  finishes. Claude Code's hook timeout bounds how long that can take.

## Plugging it in

`composeHook({ env, argv, decide })` is the composition root; `decide` is the
seam. Today `main.ts` passes `decideFromConfig`, a placeholder that refuses
every call (an installed hook is never silently open), and tests inject their
own through `run` (`test/fixtures/refusing-hook.ts`). After the core
integration, `decideFromConfig` loads the project's `bounded.config.ts`,
composes its packs and judges the event; nothing else changes. At the same
time `event.ts`'s local `ToolUse`, `Effect`, `ToolKind` and `Change` give way
to the core's exports of the same names.

To install, read `.claude/settings.json` (or `{}`), pass it to
`withHook(settings, command)` with the command that runs `src/main.ts`, such
as `bun /path/to/apps/claude-code/src/main.ts --role builder`, and write the
result back when `changed`. Claude Code runs hooks with its own `PATH`, so
either make sure `bun` is on it or give bun's absolute path in the command.
`withHook` appends one `PreToolUse` entry with an empty matcher (every tool),
the fail-closed wrapper and the timeout, and keeps every other setting and
hook. An existing entry counts as already installed only when it runs the
same wrapped command as a `command` hook for every tool (matcher `""`, `"*"`
or none). It refuses settings with `disableAllHooks: true`, where no hook
would run.
