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
4. `src/hook.ts` — one call from stdin to stdout, and how it fails closed.
5. `src/composition-root.ts`, then `src/main.ts` — the wiring and the entry file.
6. `src/install.ts` — merging the hook into `.claude/settings.json`.
7. `test/main.e2e.test.ts` — the hook run as Claude Code runs it.

## The tool map

| Claude Code tool | Tool kind | Effects |
| --- | --- | --- |
| Read | read | read `file_path` |
| Write | write | write `file_path`: create if it does not exist, else modify |
| Edit, NotebookEdit | edit | write `file_path` / `notebook_path`: modify |
| MultiEdit | edit | modify, once per distinct path (`file_path` and any edit's own) |
| LS | search | list root `path` |
| Glob | search | list root `path` (else the session's directory), filter `pattern` |
| Grep | search | list root `path` (else the session's directory), filter `glob`; read the root. The regex is not an effect |
| Bash | shell | execute `command` |
| Agent, Task | subagent | delegate to `subagent_type` (Claude Code's default, `general-purpose`, when absent) |
| WebFetch | web | fetch `url` |
| WebSearch | web | invoke `WebSearch` |
| anything else (Skill, `mcp__*`, ...) | other | invoke the tool's name |

An invoke is a tool call whose effects cannot be described: WebSearch names
no URL, and inventing one would mislead a guard, and an unknown tool's effects
are unknown. It is never an execute, which is strictly a shell command that
gates parse as one. A project that refuses unknown capabilities does it with
one guard on `invoke`.

A required field that is missing or not text refuses the call; nothing is
passed through unchecked.

## Paths

Claude Code does not expand `~`, `@` or `file:`, so a path starting with one
is refused rather than guessed at. Any other path is resolved against the
session's `cwd` (from the payload; the project root when absent), and its
existing components through `realpath`: a link is judged by where it lands,
a path that does not exist yet by its nearest existing parent, and a link to
nothing is refused. The result must be inside the project, whose root is
`CLAUDE_PROJECT_DIR` (never the payload's `cwd`: a session started in a
subdirectory would otherwise treat that as the root). A path written outside
the project that is a link into it is accepted, as the place it lands.
Whether the file exists also tells a Write's create from its modify.

## Answers

- allow: empty stdout, exit 0. Claude Code's own permissions still apply.
- refuse: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason>\n<redirect>"}}`, exit 0.
- Empty or malformed stdin, an untranslatable call, a refused path, a
  missing `CLAUDE_PROJECT_DIR`, a decide that throws or returns no verdict:
  all refuse. The process always exits 0, because Claude Code does not
  block on a crash.

## Plugging it in

`composeHook({ env, argv, decide })` is the composition root; `decide` is the
seam. Today `main.ts` passes `decideFromConfig`, a placeholder that refuses
every call (an installed hook is never silently open), and tests inject their
own (`test/fixtures/refusing-hook.ts`). After the core integration,
`decideFromConfig` loads the project's `bounded.config.ts`, composes its packs
and dispatches over the composed guards; nothing else changes. At the same
time `event.ts`'s local `ToolUse`, `Effect`, `ToolKind` and `Change` give way
to the core's exports of the same names.

To install, read `.claude/settings.json` (or `{}`), pass it to
`withHook(settings, command)` with the command that runs `src/main.ts`, such
as `bun /path/to/apps/claude-code/src/main.ts --role builder`, and write the
result back when `changed`. It appends one `PreToolUse` entry with an empty
matcher (every tool), keeps every other setting and hook, and does nothing
when an entry already runs the command.
