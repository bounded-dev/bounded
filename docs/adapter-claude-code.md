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
2. `src/event.ts` — the `PathResolver` port, and `toToolUse`, which resolves
   every path through the port and builds the core's `ToolUse` with its parse.
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
filter `*`. Glob syntax can hide a climb or an absolute path where folding
cannot see it (`{../out,src}/*`, `{/etc,src}/*`, `@(..)/x`, `\.\./x`,
`[.][.]/x`), so the adapter refuses, conservatively: any escape (`\`), any
`/` inside a brace or extglob group, any character class that can match `.`,
`..` anywhere in the part after the fixed prefix, and a negated filter that
climbs. Ordinary filters (`**/*.{ts,tsx}`, `src/[abc]*.ts`) pass unchanged.

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
- `decide` is asynchronous (the core's judging awaits its guard log). If
  it has not settled within 20 seconds the call is refused. The deadline
  bounds asynchronous work only: a decide that is busy synchronously holds
  the process and can still overrun it.
- Claude Code proceeds when a hook exits with anything but 0 or 2, so the
  hook never relies on its own exit code to refuse. `main.ts` is a bootstrap
  with no static imports: it loads the rest inside a `try`, so a missing
  module or a syntax error is still a deny with exit 0. When the process
  cannot start at all (bun not on `PATH`, killed for memory), the installed
  command's wrapper (`... || { echo "bounded hook failed" >&2; exit 2; }`)
  blocks the call.
- After writing its answer the hook sets `process.exitCode` and lets the
  event loop drain, so work still pending (the core's guard log may write
  a follow-up line after a late record settles) can finish, but for at most
  5 seconds: then it exits. Deadline plus drain (25 seconds) ends well before
  the 30-second `timeout` the install helper sets on the hook entry, because
  Claude Code does not block a call whose hook it had to abort.

## Plugging it in

`composeHook({ env, argv, decide })` is the composition root; `decide` is the
seam, and it is told the project (`{ projectRoot }`, from
`CLAUDE_PROJECT_DIR`). `main.ts` passes `decideFromConfig`, which calls the
core's `openProject(projectRoot, { ports: [...pathGateFileSystem(), ...pathGateTreeSitter()] })` (`bounded/open-project`, with the path gate's file-system ports and shell parser) and then
`judge(event)`: the core composes the packs `bounded.config.ts` selects,
decides, and records the decision in `.bounded/guard-log.jsonl`. A refusal
from the core already names the refusing pack and effect (`test-packs/no-generated
refused write (create) generated/api.ts: ...`) and is passed to Claude Code as
it is, reason then redirect. A project whose configuration is missing or
broken is refused by the core with "This project's configuration cannot be
used: ...". Anything `openProject` or the judge throws or rejects with is a
deny from the hook, and both count against the 20-second deadline. Tests
inject their own decide through `run` (`test/fixtures/refusing-hook.ts`).

Events are the core's `ToolUse`, built with `ToolUse.parse`, so the adapter
cannot hand the core a shape it does not accept. Claude Code's `tool_use_id`,
when given, is the event's `callId`.

Two more seams, both optional, are passed beside `decide` (`main.ts` passes
the `...FromConfig` ones, which open the project the same way):

- `record(refusal, project)`: every deny the hook makes itself (unreadable
  input, an untranslatable call, a refused path, the deadline, a decide that
  fails) is handed to the project's `refuse`, which records it in the
  guard log as an `"adapter"` decision with Claude Code's tool name and
  input. It is not awaited: a recording that fails or hangs never changes or
  delays the deny. Refusals from the core are already recorded by its judge.
- `afterTool(result, project)`: on `PostToolUse` the finished call becomes the
  core's `ToolResult` (translated as before the call; a call that cannot be
  translated is an `invoke` of its tool name, so it is still checked) and the
  project's `afterTool` undoes what a shell command changed in watched files
  (see [drift.md](drift.md)). When it says something was undone, the hook
  answers `{"decision":"block","reason":"<message>"}`, which Claude Code shows
  to Claude; when nothing was, it answers nothing. If checking fails or runs
  past the deadline, the answer says so and asks for the files to be checked
  against version control: never silence; the failure is also recorded.
  Without `afterTool`, `PostToolUse` answers nothing.
- A call that fails (a Bash command exiting non-zero, a tool that errors)
  reaches `PostToolUseFailure`, not `PostToolUse`, so `echo x > protected;
  exit 1` would otherwise escape the check. It is checked the same way, as a
  result with `ok: false`; since that event cannot block, the message is
  given as `{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"<message>"}}`.
  A call the hook denied fires neither event. Interrupting a running call
  (Esc) fires no hook at all, per Claude Code's documentation: the
  interruption reaches Claude in the tool result. Such a call goes unchecked
  and its snapshot expires (see [drift.md](drift.md)).

`bounded init` and `bounded update` install the hook for you (README,
"Installing"). They load this package's `./host-installer` export
(`src/host-installer.ts`, [ADR 2026-015](adr/2026-015-host-installers.md)).
It runs `bun` on the project's own
`node_modules/bounded-claude-code/src/main.ts`, through `withProjectHooks`.
That first removes every bounded hook without a role (`isBoundedHook`: a
command running bounded-claude-code's or a checkout's
`apps/claude-code/src/main.ts`, at any path), so the hook of a moved or
re-cloned project is replaced, not duplicated. The command is an absolute
path, so a `.claude/settings.json` committed and checked out elsewhere needs
`bounded update` there before the hook runs. Settings that exist but cannot
be read, or are not JSON, are refused and left alone.

To install by hand, read `.claude/settings.json` (or `{}`), pass it to
`withHooks(settings, command)` with the command that runs `src/main.ts`, and
write the result back when `changed`. `hookCommand({ bun, main, role })`
builds that command with every path shell-quoted, such as
`'bun' '/path/to/apps/claude-code/src/main.ts' --role 'builder'`. Claude Code runs hooks with its own `PATH`, so
either make sure `bun` is on it or give bun's absolute path in the command.
`withHooks` installs the same command for `PreToolUse`, `PostToolUse` and
`PostToolUseFailure`
(`withHook(settings, command, event)` does one event, `PreToolUse` by
default). Each gets one entry with an empty matcher (every tool),
the fail-closed wrapper and the timeout, and keeps every other setting and
hook. The wrapper puts the command on its own line inside a group (`{`, a
newline, the command, a newline, then
`} || { echo "bounded hook failed" >&2; exit 2; }`), so a comment or `;` in
the command cannot escape it. A hook running an older form of the
same command (unwrapped, or the earlier one-line wrapper) is removed and
replaced rather than left beside the new one. An existing entry counts as already installed only when it runs the
same wrapped command as a `command` hook for every tool (matcher `""`, `"*"`
or none). It refuses settings with `disableAllHooks: true`, where no hook
would run.
