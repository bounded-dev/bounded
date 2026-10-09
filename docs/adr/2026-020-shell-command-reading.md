# 2026-020: The core carries a shell command's reading; a private context, `bounded-shell-command-reader`, reads it

**Status:** accepted (the maintainer's brief and direction, two plan
reviews, and the orchestrator's decisions on the maintainer's behalf).
Item (i), `parsed-shell-commands`, of a two-part split; (ii),
`prereqs-execute`, gives `bounded/prereqs` `before: { execute }` and shell
writes. Ships in `bounded` 3.2.0 (see "Release"). Amends ADRs 2026-006,
2026-009, 2026-010, 2026-013, 2026-016 and 2026-017. Amended by
[ADR 2026-024](2026-024-src-layout.md) (src layout): the reader's context
is `src/lib/shell-command-reader`, its layers directly in it, with no inner
`src/`. **Corrected in 3.3.0 (item `host-side-reading`), not superseded:**
the host adapter, trusted code, builds each execute effect's reading from
the model's tool input, the untrusted part, with bounded's reader. The core
requires the reading and checks its shape. The sections below state the
decision as corrected; "Release" keeps what 3.2.0 shipped and lists the
correction's changes under 3.3.0.

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

- **An execute effect carries a required `reading: ShellCommandReading`**,
  a value object (`src/core/domain/events/shell-command-reading.*`) with
  two outcomes: `{ outcome: "read", programs, fileEffects, unresolved }`
  or `{ outcome: "unread", why, cause? }`, where a reader that can tell says
  what made the command unreadable when the command itself is to blame
  (`too-complex`).
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
    A token tree-sitter inserted to recover from an error (the missing
    command after `cat a |`) is never a literal word: it is an unresolved
    word named `(a token the parser inserted to recover)`, and any other
    part of no text `(a part of no text)`, since a reading names every part.
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
  - **Brace expansion is read every way a shell running the command could
    expand it**, so every path either shell could touch is judged. Comma
    lists (`{a,b}`) and ranges expand, nested, left to right; quoted and
    escaped braces never do; a group that is no range (`{1..a}`,
    `secret{1..2..3..4}`) stays as written and the next group still
    expands, as in bash. Bash 3.2 (macOS's `/bin/bash`) neither pads nor
    steps a range; bash 4 and later, and zsh, do. So a zero-padded range
    gives both shells' words (`rm key{01..02}.pem`: `key01.pem`,
    `key02.pem`, `key1.pem`, `key2.pem`), and a stepped one gives its
    stepped words and the word as written, which bash 3.2 keeps literal
    (`rm f{1..5..2}`: `f1`, `f3`, `f5`, `f{1..5..2}`). Letter ranges step
    too (`{a..e..2}`). Unresolved, because the shells disagree: a step of
    zero or below, and a zero-padded range with a negative end; also a
    range past the integers held exactly, and any word that would expand
    to more than 256 words.
  - **Reading is bounded in time, because the reader is synchronous:**
    `ReadShellCommand`'s `readWithinMs` (see "Reading in the host adapter")
    cannot stop it, and a hook that ran out of time would let the call
    through. Each bound below makes the command **unread**
    with cause `too-complex` (never a reduced reading), which the path gate
    refuses, telling the agent to split or simplify the command:
    - **The backstop, a deadline of 1,000 ms per read on a monotonic clock**
      (`performance.now()` by default; a reader may be given another clock,
      and `readDeadlineMs` must be a finite number above zero, else a
      RangeError), whatever the steps count. The adapter builds a
      host-neutral "has the time run out" function and asks it at four
      kinds of site, each named in the why ("the command is too complex to
      read within the time bounded allows for one command (…)"):
      tree-sitter's own parse, through its progress callback, which cancels
      the parse (the shared parser is then reset) — "(parsing it)"; the
      walk of the syntax tree, at its first node and every 64th — "(walking
      its syntax tree)"; brace expansion, at every pass and every 4,096
      characters within one — "(expanding its braces)"; and the domain,
      through `ShellPlace`, every 64 charges of its budget and once at the
      end — "(reading what it does)". The domain does no I/O: it only calls
      the function. Tests use a clock that runs out after a counted number
      of questions, so removing any one site fails a test.
    - **Input size, checked before parsing:** at most 65,536 characters ("the
      command is too long to read: N characters, past bounded's limit of
      65536"). There is no word limit: a long heredoc is read.
    - **Brace expansion: each pass is linear, and passes are charged.** A
      pass finds every group with one stack scan, then looks at each group in
      constant time: a comma list (which ends the pass) is sliced, and a
      group is sliced and tested as a range only when it is at most 48
      characters long, or holds nothing but digits, dots and minus signs,
      found by a scan that stops at the first other character (so nested
      groups, which start with one, cost constant time each, and the groups
      it lets be sliced never overlap). The range patterns are anchored and
      have no nested quantifiers, so they backtrack at most linearly; a long
      group of digits and dots that is no range stays a literal word, as in
      bash, and a long one that is a range is spelt out or, past 256 words,
      unresolved. Each pass is charged its length,
      and a command may spend 1,000,000 characters of passes ("expanding its
      braces would take more work than bounded allows"); text with no brace
      is not charged. The number of passes is bounded by that charge, not by
      the text: expansion is linear per pass, not overall. Quoted and escaped
      braces arrive escaped and never expand. Expansion still stops at 256
      words, past which the word is unresolved, as before.
    - **The tree is walked at most 1,000 levels deep** ("it nests more than
      1000 levels deep"), so very deep nesting is unread, never a stack
      overflow.
    - **One work budget per command: 200,000 steps, and nesting at most 64
      deep.** The budget counts work, not calls: a step for each command and
      each node of its syntax tree, one for each word a command is given or
      a reading of xargs's options slices, one for each word resolved (and
      one more per 64 of its characters), one for each look at what is at a
      path, and, for a nested shell's code, one per 16 characters each time
      it is parsed; a short option cluster, read for every value it could
      carry, costs its suffixes' total length (a step per 64 characters,
      counted without integer overflow), and carrying where a `cd` took
      later commands costs a step per 8 characters of its joined path
      wherever it is copied, joined or compared (so one long directory name
      costs what as many short ones do); a cost that is not a count of steps spends the
      whole budget. Readings, nested runs and the reports of xargs's input
      all share it, and nothing is kept past it. Why: "the command is too
      complex to read within bounded's work budget (200000 steps): its words
      could be read too many ways, or it nests too deep".
    - Measured (one run each): a realistic 488-line install script
      (`test/fixtures/install.sh`) reads in 8 ms and 3,897 steps, 2% of the
      budget; a 60 KB heredoc reads in 2 ms; a 5,000-word `cat` in 10 ms; a
      50,000-character command in 12 ms; a 4 KB single-quoted JSON body in
      under 1 ms. Read: `echo` with `"{" × 32,765 + "}" × 32,765` in 122 ms,
      `{` + 65,000 dots + `\x}` in 3 ms, 2,000 groups nested around 60,000
      dots in 7 ms, one word of 60,000 `{` in 77 ms. Unread: `"xargs $A " ×
      24` with 5,000 words in 9 ms, `"xargs --b " × 14` over a 4 KB `sh -c`
      script in 8 ms, `{a,b}` × 10,000 in 45 ms, `"(" × 30,000 + ")" ×
      30,000` in 15 ms, `grep -` + 65,000 letters in 2 ms, a 16,000-level
      `cd` before 1,400 `if`s in 67 ms, a 30,000-character directory before
      15,000 words in 94 ms. A test pins each of these outcomes, none of them
      for want of time. Two seeded fuzz tests, each read under 250 ms, never
      throwing and never unread for want of time: 300 random strings of
      shell metacharacters and words, up to 65,536 characters (slowest
      53 ms), and 120 balanced nests of brace groups, command substitutions,
      ifs and cases, up to 1,100 deep and 65,536 characters (slowest 46 ms).
  - **The cause.** An unread reading carries `cause: "too-complex"` only
    when the command itself is to blame. The parser returning no tree is a
    failure of the parser, not of the command, so it carries no cause, as
    `ReadShellCommand`'s own unread readings do (a reader that failed or was
    too slow, an answer that could not be used, an input that is no
    command): they keep the redirect to reinstall bounded's dependencies.
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
- **On the wire `reading` is required.** `Effect.parse` refuses an execute
  without one ("An execute effect is { kind, command, cwd?, reading }") and
  checks the one it is given with `ShellCommandReading.parse`; `toJSON`
  always writes it. Nothing stored holds an execute's wire form (the
  Bounded log records effects described as text, ADR 2026-022), so no
  stored data changes shape (ADR 2026-012).
- **Tool results carry readings too.** An effect has one shape, so a tool
  result's execute effects carry a reading as a tool use's do. The host
  adapter builds a result's effects as it built the call's, from the same
  tool input, so it reads the command again after the call: **a result's
  reading may differ from the call's** (the files it names may now exist).

### Reading in the host adapter

- **The trust model.** The host adapter is trusted code; the model's tool
  input is the untrusted part, and what is judged. So the host adapter
  reads every execute effect's command with bounded's reader when it
  translates the host's payload into the core's event, and puts the reading
  on the effect; the core checks the reading's shape and judges with it as
  given.
- **`ReadShellCommand`**, the reader library's in port
  (`src/lib/shell-command-reader/application/shell-commands/read-shell-command/`),
  is what a host calls. `prepare()` starts the reader's preparation once and
  never rejects: a preparation that fails, throws or never settles is let
  go, and reading works unprepared or says why it cannot.
  `read({ projectRoot, command, cwd })` gives the reading's wire form and
  never rejects: an input that is no command (a blank command, a directory
  outside the project, a relative root) is unread with its parse error, and
  the reader is not asked; otherwise the reader's answer is parsed by
  `ShellCommandReading.parse`. A synchronous throw from the reader is handled
  as a rejection.
- **Two bounds.** `readWithinMs` (2000 by default) bounds the reader's work
  on one command; each command of a call is read under it. A read started
  while the reader's preparation is in flight first waits for it, up to
  `prepareWithinMs` (5000 by default, the packs' own bound for their work
  when a project opens), before its own bound starts. Each bound that is not
  a finite number of milliseconds above zero is a RangeError.
- **The whys, exactly:** a rejection: its message (the tree-sitter reader's
  is "bounded's shell parser could not load (<cause>)"); an answer that is
  not a reading: "the shell command reader gave a reading that cannot be
  used: <error>"; too slow: "reading the command did not finish within <n>
  ms (timed out)".
- **The cold start.** Claude Code runs each hook in a new process, so its
  first read waits for the grammar: at most `prepareWithinMs` (5 s) then
  `readWithinMs` (2 s), within the hook's 20 s deadline. pi prepares at
  session start, so its calls normally find the grammar loaded; a call made
  while loading still runs takes longer than pi's 3 s decision deadline and
  is blocked (fail closed).
- **The host's decision deadline covers the whole call**: reading its
  commands and deciding, on both hosts, as before the correction.
- **The core's part.** `Effect.parse` requires the reading and checks its
  shape. An execute without one makes the event one that cannot be read:
  the judge refuses it ("The host sent an event that cannot be read: …") and
  records it as invalid. The judge passes readings through untouched, and
  the core never refuses for an unread reading; a pack that needs one
  refuses (fail closed).

### The reader's port

`ShellCommandReader` (`prepare()`, `read(projectRoot, command, cwd)`) is
declared in the reader library's `read-shell-command.contract.ts`, the out
port of `ReadShellCommand`, and tagged `@implementedBy
TreeSitterShellCommandReader`, so R2 holds it as any tagged port: its
adapter runs its conformance suite. The core declares no reader. R2's
provision for an adapter in another context implementing an untagged port
of an application contract (`implementedByViolations`: the port's suite,
`suitePathOf`, beside the contract, and a test beside the adapter importing
it through an export path of the declaring package) is kept, and has no
user now. An untagged port implemented in its own context is still refused.

### The reader's context

- **`src/lib/shell-command-reader`, package `bounded-shell-command-reader`
  (private, at the lockstep version)** owns the bash syntax tree and its
  walk, the command-meanings table (an opinion about tools, kept out of the
  core package), tree-sitter (`@vscode/tree-sitter-wasm`, pinned),
  `TreeSitterShellCommandReader`, its `ShellCommandReader` port and the
  `ReadShellCommand` feature. The core keeps only the shape, so "the core
  names no tool" stays literally true. Rejected: the reader in the core's
  own `adapters/out/`, and a carve-out inside the core package.
- **Layout:** `domain/` (pure, importing only `bounded/domain`):
  `shell-command.*` (the syntax-tree types and `describeShellCommand`) and
  `command-meanings.*`; `application/shell-commands/read-shell-command/`:
  the feature's contract, command, handler and the port's conformance
  suite; `adapters/out/shell-command-reader/`: the class, and helpers
  exporting only functions and types (`bash-syntax-tree.ts`, the grammar
  loaded once per process and a synchronous parse; `brace-expansion.ts`;
  `path-kinds.ts`); `composition-root/shell-command-reading.ts`:
  `openShellCommandReading`, and the end-to-end tests. The adapter's
  constructor takes `{ pathKindOf?, loadGrammar? }`.
- **Three exports:** `./adapters`, `./application` and
  `./shell-command-reading` (the composition root). Its adapters reach its
  own domain by relative path: a context's layers import each other through
  the package's export path for the layer when it has one, and this package
  exports none for its domain (the architecture test's import rule says
  so). Hosts import values only from `./shell-command-reading` in their
  non-test code; their tests may import `./application`.
- The grammar hangs a redirection after `a && b` (or `a | b`) on the whole
  list; the reader gives it to the last command, as the shell does, so
  `cd sub && echo x > out.txt` writes `sub/out.txt`.

### The published `bounded/shell-command-reader`

- `bounded` publishes the reader as `./shell-command-reader`
  (`{ types, default }`, only in dist, like `./hosts/*`), built by
  `build-dist.ts` from the reader's composition root,
  `composition-root/shell-command-reading.ts`: `openShellCommandReading`,
  `ReadShellCommandHandler`, `ReadShellCommandCommand`,
  `TreeSitterShellCommandReader` and their types. Third-party hosts read
  shell commands as bounded's hosts do.
- **Building the reader's entry,** its imports of its own package's export
  paths (`bounded-shell-command-reader/application`, `/adapters`) resolve to
  their sources, so they are built in; `bounded/*` and
  `@vscode/tree-sitter-wasm` stay external.
- **The hosts reach it through that export, not by inlining.** In source they
  import `bounded-shell-command-reader/shell-command-reading`; build-dist
  keeps every bare specifier external and maps that one private export path,
  by a plugin, to a module re-exporting `bounded/shell-command-reader`'s
  values. dist holds one copy of the reader, and its import check still
  refuses any other private package.
- **Declarations** are emitted by `tsconfig.types.json`, which names the
  reader's composition root, and placed at `dist/types/shell-command-reader/`
  with an index re-rooted from it. Each `bounded-shell-command-reader/<path>`
  specifier in them is rewritten to the relative path of that export's
  declaration, so no published declaration names the private package.
- `bounded` keeps `@vscode/tree-sitter-wasm` as a dependency, for that dist
  file; no file under `src/core` or `src/packs` imports it.

### The published suite

The suite every reader runs,
`read-shell-command.shell-command-reader.test-support.ts` in the reader's
`read-shell-command` feature, is published as
`bounded/testing/shell-command-reader-conformance` (`{ bun, types }`): the
port is public with a published reader, and a host with another shell, or a
third party, writes its own reader and must run it, as with the
host-installer suite. It names only made-up programs. bounded's tarball
ships that file and the contract it imports its port from, and nothing else
of the library's sources.

### The hosts' wiring

- `openProject(root, options)` takes no reader; its options may be left out.
  Both hosts open with `{ ports: [...protectedPathsPortProvisions(),
  ...prereqsPortProvisions()] }`.
- **Claude Code.** The composition root holds one module-level
  `openShellCommandReading()`; `composeHook` takes an optional
  `readShellCommand` (that one by default) and starts its `prepare()` once,
  without waiting. `toToolUse` reads each execute effect after resolving its
  directory. PreToolUse reads inside the hook's deadline; PostToolUse starts
  its deadline before translating and reading the call again.
- **pi.** `translate` stays synchronous and pure, given the locator: it
  gives the call's tool kind and effects, an execute's before its reading.
  The extension takes a required `readShellCommand` (the composition root's
  module-level `shellCommandReading`, passed by `bounded(root)`), starts its
  `prepare()` at each session start without waiting, reads and decides each
  call inside one decision deadline, and reads a finished call again before
  its after-tool check, under the same deadline.
- A host that cannot read gets an unread reading with its why, never an
  omitted one, and the protected-paths pack refuses it.
- The Claude Code and pi hosts depend on the private package; the cli has
  it as a devDependency, for a test. An app's tests may import its
  devDependencies; its other files may not ("… (devDependencies serve its
  tests only)").

### The path gate

(Now the protected-paths pack, ADR 2026-021.) It loses its `pathKinds` and
`shellParser` ports, its `onProjectOpen` work, `shell-check.ts`, and its
shell-command and command-meanings domain files and adapters; its port
provisions are two. Its execute guard judges from `effect.reading`, always
present: reads, then lists, then writes, with today's messages. An unread
reading is refused with its why; with no cause, its redirect is "Reinstall
bounded's dependencies if its shell parser cannot load, then retry; shell
commands are refused until the host adapter can read them", and a
`too-complex` one keeps its own. Drift (ADR 2026-011) is untouched.

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
  - `sudo "$OPT" rm x`, `doas "$X" rm x`, `env "$X" rm x`,
    `nice "$N" rm x`, `nohup "$X" rm x`, `stdbuf "$X" rm x`,
    `ionice "$X" rm x`, `builtin "$X" rm x`, `command "$X" rm x`,
    `exec "$X" rm x`: read as reads of `rm` and `x` (the unresolved word
    taken as the program); lost: the delete of `x`. (`timeout $T rm x` is
    read right: its leading operand is counted.)
  - `bash "$X" -c "rm x"`, and the same with `sh`, `zsh`, `dash` and `ksh`:
    read as nothing (the unresolved word taken as the code); lost: the code
    `rm x`, never walked, and its delete of `x`.
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

### 3.3.0 (the correction)

3.3.0 is unreleased; the correction ships in it, with no aliases:

- **API breaks:**
  - `bounded/application`'s `ShellCommandReader` is gone: the port is
    `bounded/shell-command-reader`'s, with `ReadShellCommand`,
    `ReadShellCommandHandler` and `openShellCommandReading`;
  - `openProject`'s `shellCommandReader` option is gone, and its options may
    be left out;
  - `JudgeEventHandler`'s `shellCommandReader`, `projectRoot` and
    `readWithinMs` options and its `DEFAULT_READ_WITHIN_MS` are gone;
  - `ExecuteEffect.reading` is never null, and `ExecuteEffectJSON.reading`
    is required;
  - `bounded/hosts/pi`'s `translate` gives the call before its readings
    (`PiCall`), and `piExtension` takes a required `readShellCommand`.
- **Behaviour breaks:**
  - a host that sends an execute effect without a reading, as every 3.2.0
    host did, has each such call refused as an event that cannot be read,
    and recorded as invalid;
  - a tool result's execute effects must now carry a reading too, where
    3.2.0 refused one.

## Consequences

- The lockstep versions are five: `bounded`, the three apps and
  the reader's context (docs/releasing.md).
- ADR 2026-006: an execute effect carries a required reading, built by the
  host adapter; results carry one too, read again after the call.
- ADR 2026-009: shell parsing moves to the reader's context; the path gate
  judges from the reading the host adapter gave the execute effect.
- ADR 2026-010: `openProject` takes no reader: the host adapter builds each
  command's reading.
- ADR 2026-013: the path gate's ports are watched files and shell snapshots.
- ADR 2026-016: build-dist carries the reader's context and maps its export
  path; the export list gains `./shell-command-reader` and
  `./testing/shell-command-reader-conformance`.
- ADR 2026-017: the path gate's provisions are two; `TreeSitterShellParser`
  and `FileSystemPathKinds` are gone.
