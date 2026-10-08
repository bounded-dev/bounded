# 2026-020: The core carries a shell command's reading; a private context, `bounded-shell-command-reader`, reads it

**Status:** accepted (the maintainer's brief and direction, two plan
reviews, and the orchestrator's decisions on the maintainer's behalf).
Item (i), `parsed-shell-commands`, of a two-part split; (ii),
`prereqs-execute`, gives `bounded/prereqs` `before: { execute }` and shell
writes. Ships in `bounded` 3.2.0 (see "Release"). Amends ADRs 2026-006,
2026-009, 2026-010, 2026-013, 2026-016 and 2026-017.

## Context

Only the path gate could parse shell commands: tree-sitter-bash, its
syntax-tree walk and the table of what commands do with their words lived
under `contexts/core/src/packs/path-gate/`. Shipped packs may not import
each other (ADR 2026-009), so no other pack could see what a command runs or
writes, and `bounded/prereqs` could not match `before: { execute }` nor see
a shell write (ADR 2026-019's limits). The core may not own bash parsing: it
names no tool or language (AGENTS.md). It can own the shape.

## Decision

### The shape: a field of the execute effect

- **An execute effect carries `reading: ShellCommandReading | null`**, a
  value object (`contexts/core/src/domain/events/shell-command-reading.*`)
  with two outcomes: `{ outcome: "read", programs, fileEffects, unresolved }`
  or `{ outcome: "unread", why }`.
  - `programs`: every program the command runs, nested and wrapped ones
    included (a wrapper and what it runs, literal `sh -c` code, `find -exec`'s
    and xargs's commands, builtins such as `cd`, `[` and `export`), in the
    order met; each a `ShellProgramRun` of `name` and `arguments` (words,
    `{ kind: "literal" | "unresolved", text }`) and `workingDirectory`, a
    project path ("." the root) or null when it cannot be known. The
    reader's stand-ins (the `true` it uses for a loop's words) and bare
    assignments are no programs.
  - `fileEffects`: the files it reads, lists and writes, as real
    `ReadEffect`, `ListEffect` and `WriteEffect` instances (ADR 2026-006's
    vocabulary), each `{ effect, existenceUnknown? }`; `existenceUnknown`
    marks only a create or a modify of a path whose existence could not be
    told, given as both, which carries the path gate's note.
  - `unresolved`: each part only the shell could resolve, with the role it
    would have had: `read`, `list`, `write`, `directory` or `code` (unparsed
    text, `eval`'s words, `env -S`'s trailing words, a nested shell's code
    that is not literal, and inline code for another language: `python -c`,
    `node -e`/`--eval`/`-p`/`--print`, `perl -e`/`-E`, `ruby -e`, awk's
    program without `-f`; short options cluster as getopt reads them, as in
    `perl -ne` or `python3 -Bc`, a value-taking letter ending the cluster).
  - **xargs.** Its own options are walked once, as getopt walks them, both
    to find its command and to find a replace string: in a cluster a
    value-taking letter (`I J L n P d E s a R S`) ends it and takes the rest
    of the word, or the next word when it ends the word; `-e`, `-l` and `-i`
    take only an attached value; long options match exactly or by a unique
    prefix, as getopt_long matches them (`--max-a` is `--max-args`), those
    with a value (`--max-args`, `--max-procs`, `--delimiter`, `--arg-file`,
    `--max-chars`, `--process-slot-var`) taking `=value` or the next word,
    and those whose value is optional (`--replace`, `--eof`, `--max-lines`)
    only `=value`. A replace string is given by `-I X`, `-J X` (BSD), `-iX`,
    `--replace=X`, or a bare `-i` or `--replace` (`{}`).
  - **A substitution adds a report, never replaces the check.** Every word
    of xargs's command is judged exactly as written, with or without a
    replace string; a nested shell's code is parsed and walked as written.
    The input is reported as an unresolved part, `(input)`, with each role
    the command gives it: where the replace string stands (`xargs -I % rm %`:
    `write`), or, without one, as one more argument after the written words,
    also shown as the program's last argument but never an operand, so a
    literal `cp` destination is judged as written. The input reaches a
    command a wrapper under xargs runs (`xargs sudo rm`, `xargs env -C d cp a`).
  - **When the reader cannot tell which word is xargs's command, it judges
    every plausible reading, and the strictest verdict wins.** An unknown or
    ambiguous long option, or a word only the shell can resolve among
    xargs's options (`xargs "$OPTS" rm …`, `xargs -d"$D" rm …`), is read
    every way it could be: as a flag, as an option taking the next word,
    and, for a resolvable word, as the command; the words after it are also
    read as operands. Nothing is ever dropped from judgement because it
    became unresolved.
  - Nothing is guessed (AGENTS.md).
- **Why a field, not more effects of the tool use.** ADR 2026-006's effects
  are what the call does, as the host describes it; a command's files are
  bounded's best-effort reading of one execute, with unknown existence and
  unresolved parts the vocabulary cannot say. The path gate consumes them per
  command, naming it ("this command reads '.env'"), and its content-search
  rule (a read and a list of one root in a call) would fire on `ls x; cat x`
  as peers. The cost: a pack judging writes looks in readings too (the path
  gate does; prereqs will).
- **Rejected: the core dispatching a reading's file effects to the read,
  list and write guard points.** It would change the path gate's messages,
  judge each file twice, and lose the existence note, which belongs to the
  command.
- **On the wire `reading` is optional**, and null in the domain when absent;
  `toJSON` writes it only when there is one, so stored and host-sent
  executes keep their shape (ADR 2026-012).

### Reading in the judge

- **The judge reads every execute effect before guards and `beforeAllow`
  run**, through the port `ShellCommandReader` (declared in
  `judge-event.contract.ts`, re-exported by `open-project.contract.ts` and
  the application barrel): `prepare()` loads what reading needs; `read(projectRoot,
  command, cwd)` gives the reading's wire form, parsed by
  `ShellCommandReading.parse`, and rejects when it cannot read. The event is
  rebuilt through `ToolUse.parse`; **a reading the host sent is replaced,
  never trusted**. A handler refusing every event reads nothing.
  `dispatchEvent` (and `decideEvent`) trust whatever reading an execute
  carries: only the judge replaces it, so hosts must judge through the
  judge-event feature (`openProject`'s judge), never dispatch a host's event
  themselves.
- **`readWithinMs` (2000 by default) bounds reading the whole event**: every
  execute of a call is read at once, and each still unread at the bound is
  unread, timed out. A synchronous throw from `read` or `prepare` is handled
  as a rejection.
- **The whys, exactly:** no reader: "this project was opened without a shell
  command reader: the host passes one to openProject"; a rejection: its
  message (the tree-sitter reader's is "bounded's shell parser could not load
  (<cause>)"); an answer that is not a reading: "the shell command reader
  gave a reading that cannot be used: <error>"; too slow: "reading the
  command did not finish within <n> ms (timed out)". The core never refuses
  for an unread reading; a pack that needs one refuses (fail closed).
- **Tool results carry no reading**: `ToolResult.parse` refuses one ("A tool
  result's execute effects carry no reading: bounded reads a command only
  when it judges it"), and results are never read.

### The untagged port and R2 across contexts

`ShellCommandReader` is untagged, as `HostInstaller` is, so the core's
sources name no reader. R2 (`implementedByViolations`) lets an out adapter
in another context implement an untagged port of an application contract
only when the port's suite (`suitePathOf`) exists beside the contract and a
test beside the adapter imports it through an export path of the declaring
package. An untagged port implemented in its own context is still refused.

### The reader's context

- **`contexts/shell-command-reader`, package `bounded-shell-command-reader`
  (private, at the lockstep version)** owns the bash syntax tree and its
  walk, the command-meanings table (an opinion about tools, kept out of the
  core package), tree-sitter (`@vscode/tree-sitter-wasm`, pinned), and
  `TreeSitterShellCommandReader`. The core keeps only the port, the shape and
  the wiring, so "the core names no tool" stays literally true. Rejected: the
  reader in the core's own `adapters/out/`, and a carve-out inside the core
  package.
- **Layout:** `src/domain/` (pure, importing only `bounded/domain`):
  `shell-command.*` (the syntax-tree types and `describeShellCommand`) and
  `command-meanings.*`; `src/adapters/out/shell-command-reader/`: the class,
  and helpers exporting only functions and types (`bash-syntax-tree.ts`,
  the grammar loaded once per process and a synchronous parse;
  `brace-expansion.ts`; `path-kinds.ts`); `src/composition-root/`: end-to-end
  tests only; no application layer. The constructor takes
  `{ pathKindOf?, loadGrammar? }`.
- **One export, `./adapters`.** Its adapters reach its own domain by
  relative path: a context's layers import each other through the package's
  export path for the layer when it has one, and this package exports none
  for its domain (the architecture test's import rule says so).
- The grammar hangs a redirection after `a && b` (or `a | b`) on the whole
  list; the reader gives it to the last command, as the shell does, so
  `cd sub && echo x > out.txt` writes `sub/out.txt`.

### The published `bounded/shell-command-reader`

- `bounded` publishes the reader as `./shell-command-reader`
  (`{ types, default }`, only in dist, like `./hosts/*`), built by
  `build-dist.ts` from the private context with `bounded/*` and
  `@vscode/tree-sitter-wasm` external, its declarations emitted by
  `tsconfig.types.json` (which gains the context's adapter entry) and placed
  at `dist/types/shell-command-reader/`. Third-party hosts keep the shell
  reading bounded's hosts have.
- **The hosts reach it through that export, not by inlining.** In source they
  import `bounded-shell-command-reader/adapters`; build-dist keeps every bare
  specifier external and maps that one private export path, by a plugin, to a
  module re-exporting `bounded/shell-command-reader`'s values. dist holds one
  copy of the reader, and its import check still refuses any other private
  package.
- `bounded` keeps `@vscode/tree-sitter-wasm` as a dependency, for that dist
  file; no file under `contexts/core/src` imports it.

### The published suite

The suite every reader runs, `judge-event.shell-command-reader.test-support.ts`,
is published as `bounded/testing/shell-command-reader-conformance`
(`{ bun, types }`): the port is public with a published reader, and a host
with another shell, or a third party, writes its own reader and must run
it, as with the host-installer suite. It names only made-up programs. The
tarball keeps it by narrowing the guard-log test-support exclusion.

### The hosts' wiring

- `openProject(root, options)` requires `shellCommandReader` (a
  compile-time line rejects leaving it out); the feature's option stays
  optional. An untyped caller that omits it, or the options entirely, still
  gets a judge, never a throw: every command is judged unread.
- `OpenProjectHandler` prepares the reader alongside `lifecycle.open`, under
  `prepareWithinMs` or `ProjectLifecycleHandler.DEFAULT_PREPARE_WITHIN_MS`,
  and lets a failure go: reading works unprepared, or says why it cannot.
- Both hosts open with `{ ports: [...pathGatePortProvisions(),
  ...prereqsPortProvisions()], shellCommandReader }`, one module-level
  `TreeSitterShellCommandReader` each. `apps/claude-code` and `apps/pi`
  depend on the private package; `apps/cli` has it as a devDependency, for
  a test. An app's tests may import its devDependencies; its other files may
  not ("… (devDependencies serve its tests only)").

### The path gate

It loses its `pathKinds` and `shellParser` ports, its `onProjectOpen` work,
`shell-check.ts`, and its shell-command and command-meanings domain files
and adapters; `pathGatePortProvisions()` gives two provisions. Its execute
guard judges from `effect.reading`: reads, then lists, then writes, with
today's messages. A null reading is refused ("the path gate cannot check
shell commands: bounded did not read this command; openProject's judge,
given a shell command reader, reads every command"), an unread one with its
why; both redirect to opening the project with openProject and a reader.
Drift (ADR 2026-011) is untouched.

### The test moves

The path gate's shell tests are `git mv`ed to the new context, their titles
kept under describes prefixed "read by bounded's shell command reader — ";
every moved or replaced case is recorded in `superseded-tests.json`.

## Limits

- PowerShell (pi's `powershell` tool) is read as bash.
- In-place edits (`sed -i`, `perl -i`) are not recognised as writes.
- What programs and scripts do themselves is not seen; their code is
  unresolved where it is given inline.
- Inline-code scanning does not stop at a script operand: in
  `python3 script.py -c x`, the script's own `-c x` is also reported as
  unresolved code. It errs towards more unresolved parts, never fewer.
- A transfer whose sources are not written at all, or only the shell can
  resolve, records no write: `xargs cp -t dir` without a replace string
  (every source comes from the input, after the written words) and
  `cp $X dir/` (an unresolved source into a directory) name no file in
  `dir`, so nothing there is judged. This gap is the transfer reading's,
  older than this ADR, and not fixed here. The replace-string forms are not
  in it: `xargs -I{} cp {} .git/hooks/`, its `mv` and `cp -t .git/hooks {}`
  are judged as written, a write of `.git/hooks/{}`.
- **An unresolved word hides a literal one; planned: every-plausible-reading,
  as xargs now does.** Outside xargs, where an unresolved word stands where
  an option or operand could be, the reader takes it for one reading only,
  and a literal word after it leaves judgement (each already so before this
  ADR; a follow-up item):
  - `sudo "$OPT" rm x`, `env "$X" rm x`, `nice "$N" rm x`,
    `command "$X" rm x`, `exec "$X" rm x`: read as reads of `rm` and `x`
    (the unresolved word taken as the program); lost: the delete of `x`.
    (`timeout $T rm x` is read right: its leading operand is counted.)
  - `bash "$X" -c "rm x"`: read as nothing (the unresolved word taken as the
    code); lost: the code `rm x`, never walked, and its delete of `x`.
  - `git $OPTS rm x`: read as reads of `rm` and `x` (no subcommand found);
    lost: `git rm`'s delete of `x`.
  - `cp -t "$D" x`: read as a read of `x`; lost: the write into the
    directory, which only the shell can name.
  - `env -S $S rm x`: read as nothing (`$S` unresolved code, the words after
    it only reported as unresolved); lost: `rm x` and its delete of `x`.
- A pack judging writes must look in readings as well as write effects.
- `bounded/prereqs` does not use readings yet (item (ii)).

## Release

3.2.0 is unreleased; this change ships in it, with no aliases:

- **Removed from `bounded/path-gate`:** `PathKind`, `PathKinds`,
  `ShellCheck`, `ShellParser`, `pathKindsPort`, `shellParserPort`, and
  `PathGatePorts`' (and `pathGate.ports`') keys `pathKinds` and
  `shellParser`.
- **Removed from `bounded/path-gate/adapters`:** `TreeSitterShellParser` and
  `FileSystemPathKinds`.
- **Changed:** `pathGatePortProvisions()` gives two provisions;
  `openProject` requires `shellCommandReader`.
- **Added:** `bounded/shell-command-reader` and
  `bounded/testing/shell-command-reader-conformance`; the execute effect's
  `reading` and the domain's `ShellCommandReading`; the application's
  `ShellCommandReader`.
- **Behaviour:** a host built without the reader refuses every shell command
  where the path gate is selected.

## Consequences

- The lockstep versions are five: `bounded`, the three apps and
  `contexts/shell-command-reader` (docs/releasing.md).
- ADR 2026-006: an execute effect carries a reading; results carry none.
- ADR 2026-009: shell parsing moves to the reader's context; the path gate
  judges from the reading.
- ADR 2026-010: `openProject` requires a shell command reader.
- ADR 2026-013: the path gate's ports are watched files and shell snapshots.
- ADR 2026-016: build-dist carries the reader's context and maps its export
  path; the export list gains `./shell-command-reader` and
  `./testing/shell-command-reader-conformance`.
- ADR 2026-017: the path gate's provisions are two; `TreeSitterShellParser`
  and `FileSystemPathKinds` are gone.
