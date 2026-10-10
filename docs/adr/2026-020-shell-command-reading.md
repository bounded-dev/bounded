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
correction's changes under 3.3.0. Amended by `prereqs-execute` (3.3.0):
xargs's replace string and find's `{}` are listed as unresolved in
`programs`; a shell reading its standard input reports it as code.
Amended by `shell-every-reading` (3.3.0): every reading adds; every
plausible reading wherever a wrapper, a shell, git, `env -S` or a
variable-named program could hide a command; only runs in the same shell
share it; short option clusters read as getopt reads them; transfers from
unknown sources report their write; ranges read every way the recorded
shells read them (see "Every reading adds").

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
  - `programs`: the runs the reader knows, nested and wrapped ones included
    (a wrapper in its table and what it runs, literal `sh -c` code,
    `find -exec`'s and xargs's commands, builtins such as `cd`, `[` and
    `export`), in the order met; not every program the command runs (see
    Limits: what is not listed); each a `ShellProgramRun` of `name` and `arguments` (words,
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
    `perl -ne` or `python3 -Bc`, a value-taking letter ending the cluster;
    *amended by `prereqs-execute`:* `(standard input)`, the code a shell
    (`sh`, `bash`, `zsh`, `dash`, `ksh`) reads from its standard input.
    **A shell's options are read every way the shells read them, and the
    union judged** (the strictest reading wins, as for xargs). Recorded
    from the shells themselves (bash 3.2.57 and zsh 5.9 on macOS, with its
    `/bin/sh`; bash 5.3 and its image's busybox-style `sh`; dash 0.5.12 and
    ksh93 20240113, with Debian's dash as `sh`):
    - a short option cluster is read letter by letter: `c` makes the first
      operand code, `s` reads standard input, anywhere in the cluster;
    - bash's `o` and `O`, and dash's `o`, each take the next whole word and
      the cluster goes on (`bash -oe pipefail` reads standard input,
      `bash -oc posix 'echo CODE'` runs CODE, `bash -oo errexit pipefail`
      takes both words);
    - zsh's and ksh's `o` take the rest of the word, or the next word when
      `o` ends the cluster (`zsh -euo pipefail`);
    - zsh's `O` is a flag (`zsh -Oc 'echo CODE'` runs CODE, `zsh -Os x`
      reads standard input with `x` as `$1`); dash and ksh refuse `-O`;
    - in every one, `-` before an operand ends the options and the operand
      is the script (`bash - script.sh` runs `script.sh`); `-` alone is
      the script, standard input; `--` ends the options.

    bash's `o`/`O`, dash's, and zsh's and ksh's readings are applied to the
    shell so named; for `sh` or a shell named any other way every reading
    is taken. Each fork is charged to the work budget and memoised.
    `--rcfile` and `--init-file` take the next word or `=value`, a file
    read at startup; bash's other long options take none. A long option
    bounded does not know, and ksh's `-R` (a value option taking a file),
    may have taken any word: standard input is reported, failing closed.

    A reading runs code from standard input when it has no script, `s` in
    a cluster, or a script operand that may be standard input, failing
    closed: `-`; a path under `/dev/` or `/proc/` (`/dev/stdin`,
    `/dev/fd/<n>`, `/proc/self/fd/0`, `/proc/thread-self/fd/0`, however
    spelt); a path with a `..` segment; or one that names no project path
    from where the command runs (`/opt/x.sh`, `../../dev/stdin`). Every
    operand is still read as written. *Amended by `shell-every-reading`:*
    a word only the shell can resolve where the shell's options are
    (`bash "$S"`, `bash "$X" deploy.sh`) may be a cluster holding `s`, so
    standard input is reported (see "Every reading adds"); one after the
    options (`bash -- "$S"`) is still read as written only. Examples:
    `echo … | sh`, `bash <<EOF`,
    `curl … | bash`, `bash -euo pipefail <<< …`, `bash -oe pipefail <<< …`;
    a heredoc fed to a shell is not parsed as code).
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
    *Amended by `prereqs-execute`:* a word holding the replace string is
    listed as the unresolved `(input)` among the run's words in `programs`,
    its name too (`echo apply | xargs -I{} terraform {}` lists
    `terraform [(input)]`), so a rule cannot match what only the input
    names. `find -exec`, `-execdir`, `-ok` and `-okdir` treat `{}` the same
    way, with the stand-in `(found path)`: listed in `programs` and reported
    with each role the command gives it. `fileEffects` do not change: every
    word is still judged as written (`find . -exec cat .env {} \;` reads
    `.env`).
  - **When the reader cannot tell which word is xargs's command, it judges
    every plausible reading, and the strictest verdict wins.** An unknown or
    ambiguous long option, or a word only the shell can resolve among
    xargs's options (`xargs "$OPTS" rm …`, `xargs -d"$D" rm …`), is read
    every way it could be: as a flag, as an option taking the next word,
    and, for a resolvable word, as the command; the words after it are also
    read as operands. Nothing is ever dropped from judgement because it
    became unresolved.
  - **Every reading adds** (*amended by `shell-every-reading`*). Today's
    reading of every literal word is always kept, with its literal
    directory resolved, and a new reading never replaces, drops or
    relocates it. A run moves where later commands run only when it runs in
    the same shell, which the reader marks; every other run, every added
    reading's included, runs in its own copy of where it started. The
    strictest verdict over all readings wins. Mechanics:
    - **The scope.** Where commands run is an immutable scope, made only by
      `scopeAt(at)`, holding its directory's parts and the characters
      carrying it costs (`joinedLength`), so that cost is read in O(1),
      never recounted. The walk passes a cell holding the current scope; a
      `cd` replaces it; a copy is a new cell with the same scope. The
      charges are unchanged; only the time is.
    - **Runs** (`CommandMeaning.runs[]`) carry `sharesShell` (only
      `builtin`, `command` and `exec`'s own reading: `builtin cd sub; rm x`
      deletes `sub/x`) and `added` (a run a plausible reading adds beside
      today's). Every other run runs in a copy: a child process's `cd` never
      moves the shell, so `env cd sub; rm .env`,
      `find . -maxdepth 0 -exec cd sub \; ; rm .env` and `xargs cd sub; rm x`
      delete `./.env` and `./x`. The reader said `sub/.env` and `sub/x`
      before: fail-opens this fixes.
    - **ADR 2026-020's xargs rule applies wherever a wrapper, a shell, git,
      `env -S` or a program named by a variable could hide a command.** A
      word `W` only the shell can resolve, at index `i` where options
      stand, is read as: (1) what the walk took it for before (the command
      for a wrapper, the first operand for a shell, the subcommand for git:
      today's reading); and, each added, (2) a word that gives the walk
      nothing (a flag, an assignment, a leading operand such as
      `timeout`'s duration), the walk going on from `i + 1`; (3) an option
      taking the next word, from `i + 2`; for a walk with a directory
      option, (3′) that option, its value `args[i + 1]`, from `i + 2`, from
      that directory (sudo `-D` and env `-C` from where sudo or env runs,
      git `-C` from the one before), and (2′) that option with its value
      attached, from `i + 1`, from nowhere known. The walk's state goes into
      every reading (a directory an earlier option set, `timeout`'s leading
      operands left, a shell's `c` and `s`).
    - **Per command.** Wrappers (`sudo`, `doas`, `env`, `timeout`, `nice`,
      `nohup`, `stdbuf`, `ionice`): readings 1–3, and 2′ and 3′ for `sudo`
      and `env`; their forks are memoised by (index, directory, leading
      operands left), so a wrapper's readings grow with its words, never
      with their combinations (`env "A=$X"` × 10 `node app.js` is read).
      `builtin`, `command`, `exec`: readings 1–3, reading 1 sharing the
      shell. Shells (`sh`, `bash`, `zsh`, `dash`, `ksh`): `W` may also be a
      cluster that may hold `c` or `s` (reading 2) or an option taking the
      next word (reading 3), in every state, on top of the getopt walk
      above; the memo key is the index, the letter and the whole state
      (`c`, `s`), so a shell gives at most four continuations per word, each
      charged the words left. The first operand a continuation reaches is
      code where `c` may be set, else a script file; `(standard input)` is
      reported where `s` may be set or no operand is reached. So
      `bash "$X" -c "rm x"` deletes `x` (and still reads `"$X"` as written),
      `bash "$S" "$1"` reports `"$1"` as code, `bash "$X" deploy.sh` reads
      `deploy.sh`, runs it as code in one reading and reports
      `(standard input)`. git: readings 1–3, 2′ and 3′ for a word among its
      global options (`git $OPTS rm x` deletes `x`; `git "$X" sub rm x`
      deletes `sub/x`).
    - **Short clusters, as getopt reads them.** A wrapper's literal short
      cluster is read letter by letter: a letter that takes a value (the
      wrapper's short options with a value, its directory and script
      options) takes the rest of the word, or the next word when it ends
      the cluster. `sudo -Eu root rm .env` runs `rm .env` and
      `env -iu VAR rm x` runs `rm x`; before, `root` and `VAR` were read as
      the command, a fail-open this fixes. Values of options the walk knows
      are taken as written (`sudo -u "$U" rm x`, `exec -a "$N" rm x`,
      `env -C "$D" cp a b`): no fork there.
    - **`env -S`/`--split-string`.** The string is parsed as code and its
      trailing words reported as code, as before. Added: the trailing words
      also run as a command of their own (`env -S $S rm x` deletes `x`), and
      a literal string with no quote, backslash or `${` is split on spaces
      and walked through env itself, as `env <split> <trailing>`, one
      nesting level each time, so env's options in it are read as env reads
      them (`env -S '-i rm' x` deletes `x`; `env -S '-C sub rm' x` deletes
      `sub/x`); past the nesting bound the command is unread.
    - **A program only the shell can name** (a command written in the
      script, a run made from one so written, such as a wrapper's command,
      or `find -exec`'s command; never xargs's own readings, which its rule
      already reads) is also walked like an unknown wrapper: every
      literal-led suffix of its words is a command of its own, run in a
      copy, each charged its words, and its words are also read as a
      shell's (`"$SHELL" -c "rm x"`), every way any shell reads them.
      `"$W" rm x`, `"$W" -u root rm x`, `$GIT rm x` and
      `find . -exec "$C" rm x \;` delete `x`; `$TOOL x` lists
      `$TOOL [x]` and `x []`; a chain `$A $A … rm x` gives one reading
      `rm x`.
    - **Charged and deduplicated.** Every reading is charged when it is
      made (its words left), through `commandMeaning`'s budget, and asks
      the deadline as any charge does. Runs have one dedupe key (the name,
      each argument, the directory, absent, null or a word, each by kind and
      text; `trailing`, `input`, the replace string and its stand-in, and
      `sharesShell`), each key charged its words and their text; where an
      added run and one that is not share a key, the one that is not is
      kept. A meaning's scripts, reads and code are deduplicated by kind and
      text, charged the same way. xargs's dedupe is this one.
    - **Transfers from sources only the shell can name.** A move's
      unresolved source is always reported as a `write` (it is deleted),
      whatever the destination (`mv "$F" notes.txt`, `git mv "$F" …`). A
      copy or move into a destination that is a directory, or a path whose
      kind cannot be told, also reports `<destination>/<source as written>`
      as a `write` (`cp "$X" dir/`: `dir/"$X"`); a destination of unknown
      kind is still written as a file, as before. Where xargs's input would
      be such a source, the same: `ls | xargs cp -t dir` reports
      `dir/(input)`, and a moved input is a `write`. `cp -t "$D" x` already
      reported `"$D"` as a `write`.
    - **The protected-paths pack's policy on unresolved parts is kept**: a
      reading that ends only in an unresolved part (an unresolved program
      name, unseen code, a write only the shell can name) is allowed there,
      and refused by `bounded/prereqs` while a rule does not hold (ADR
      2026-019): `exec "$@"`, `sudo "$@"`, `bash "$SCRIPT"`,
      `"$CMD" --version`, `bash "$S" "$1"`, `bash "$X" deploy.sh` and
      `"$W" cd sub && rm x` among them.
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
    *Amended by `shell-every-reading`:* a range gives every word any
    recorded shell prints, plus the reading before (its words, or its
    unresolved report, kept). Recorded 2026-10-09 with `/bin/bash -c`
    (GNU bash 3.2.57), `zsh -f -c` (zsh 5.9) and `docker run --rm bash:5
    bash -c` (GNU bash 5.3.20, image digest
    `sha256:61962062d969cb46dfc2bad061d36342406fa485f64f246aa7e95693ca07df1f`),
    each printing `echo <form>` (bash 3.2.57 / zsh 5.9 / bash 5.3.20):
    `f{+1..2}`: `f1 f2` / `f{+1..2}` / `f1 f2`; `f{1..+2}`: `f1 f2` /
    `f{1..+2}` / `f1 f2`; `f{1..5..+2}`: `f{1..5..+2}` / `f{1..5..+2}` /
    `f1 f3 f5`; `f{+01..03}`: `f1 f2 f3` / `f{+01..03}` /
    `f001 f002 f003`; `f{1..{2,3}}`: `f1..2 f1..3` / `f{1..2} f{1..3}` /
    `f{1..2} f{1..3}`; `f{a{b,c}}`: `f{ab} f{ac}` in all three;
    `f{1..5..2}`: `f{1..5..2}` / `f1 f3 f5` / `f1 f3 f5`; `f{01..03}`:
    `f1 f2 f3` / `f01 f02 f03` / `f01 f02 f03`; `f{-01..2}`:
    `f-1 f0 f1 f2` / `f-01 f000 f001 f002` / `f-01 f000 f001 f002`;
    `f{1..2..-1}`: `f{1..2..-1}` / `f2 f1` / `f1 f2`; `f{a..e..2}`:
    `f{a..e..2}` / `f{a..e..2}` / `fa fc fe`. Also recorded the same way:
    `f{-5..05}` gives `f-5 … f-1 f00 f01 … f05` in zsh 5.9 and bash
    5.3.20, `f{-05..5}` gives `f-05 … f000 … f005` in bash 5.3.20, and
    `g{x{1,2}}` gives `g{x1} g{x2}` in all three. The rules:
    - padding is to the wider end's written width, the sign included, with
      the zeros after a minus (`{-01..2}`: `-01 000 001 002`);
    - a plus sign: bash reads the number (bash 3.2 neither steps nor pads,
      so a stepped group stays as written; bash 5 steps and pads to the
      written width, sign included); zsh keeps the word literal: their
      union and the word as written;
    - a negative step: bash 3.2 keeps it literal, bash 5 uses its size, zsh
      reverses: the words of its size and the word as written, the
      unresolved report kept; a step of zero is not recorded and stays
      unresolved only;
    - a zero-padded negative end: bash 3.2 unpadded, bash 5 and zsh padded:
      their union, the unresolved report kept;
    - letter steps: bash 5 steps, bash 3.2 and zsh keep the word literal:
      both, as before;
    - a group holding no top-level comma but a nested group and a range's
      `..` at its own level: bash 3.2's reading (the nested group expanded,
      the outer braces dropped: `f1..2 f1..3`), bash 5's and zsh's (the
      outer braces kept as text: `f{1..2} f{1..3}`), and the reading before
      (the rescan: `f1 f2 f3`). Without that `..`, every recorded shell
      keeps the outer braces as text, as the reading before does
      (`g{x{1,2}}`, `f{a{b,c}}`).
    `expandBraces` gives `{ words, alsoUnresolved } | TOO_COSTLY`:
    `alsoUnresolved` where the reading before reported the word unresolved
    or no word can be given; the syntax tree then gives the word as written,
    unresolved, beside its literal words. `numericOnly` and both range
    patterns admit `+`, so every group of digits, dots and signs is sliced,
    however long. Each added word is charged as any pass; the 256-word cap
    applies to the union. Both words of a padded range count towards it:
    `f{0001..0128}` (256 words) is read; `f{0001..0129}` (258) and
    `f{001..200}` (299) are unresolved.
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
      costs what as many short ones do; *amended by `shell-every-reading`:*
      that length is kept with the scope, so asking it is O(1), and a
      command that spends its budget deep in a `cd` stops costing time); a
      cost that is not a count of steps spends the
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
      *Amended by `shell-every-reading`* (one run each): read, `bash` with
      40 × `"$A"` before `-c 'rm x'` in 2 ms; `$A ` × 200 before `rm x` in
      4 ms; `env` with ten `"A=$X"` words in 4 ms; `bash` with 20 × `"$A"`
      before a 370-statement `-c` script, its code parsed once, in 11 ms;
      six nested `sudo "$A"` in 44 ms. Unread for the budget:
      `sudo "$A"` × 8 in 34 ms, × 24 in 47 ms (`env` 27 ms, `command`
      31 ms); a 16,000-level `cd` before 16,000 commands in 66 ms (560 ms
      before the scope kept its length); 2,000 range groups nested around
      `{2,3}` in 45 ms (braces). The quoted outcomes above are unchanged. A
      third seeded fuzz test, 300 commands of wrappers, shells, git and
      words only the shell can resolve, each read under 250 ms, never
      throwing and never unread for want of time (slowest 2 ms); the two
      above, 53 ms and 41 ms.
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
  while loading still runs waits for it (up to `prepareWithinMs`) and is
  blocked (fail closed) only if loading outruns pi's 3 s decision deadline.
  A preparation that never settles is cached and never retried, so every
  later shell call in that pi process waits up to 5 s for it and is blocked.
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
- A write into a directory or from a source only the shell can name
  (`cp -t "$D" x`, `cp "$X" dir/`, `mv "$F" notes.txt`) is an unresolved
  `write`, never a file effect: the protected-paths pack allows it, as its
  policy on unresolved parts is; `bounded/prereqs` refuses it while a write
  rule does not hold.
- **An unresolved word hides a literal one, where the readings do not
  reach** (*rewritten by `shell-every-reading`*, which reads every plausible
  reading for wrappers, `builtin`/`command`/`exec`, shells, git, `env -S`
  and programs named by a variable): an unquoted word that splits into more
  than two option words, or into an option and the command at once, is
  covered only as far as readings 1–3 (and the shells' and variable-named
  programs' readings) reach; wrappers and runners the table does not know
  are read as unknown commands (until `shell-reader-coverage`); a deep chain
  of wrappers each holding such a word outgrows the budget and is unread
  (`sudo "$A"` × 6 before a command is read, × 8 is not).
- **A `cd` the reading cannot place does not relocate later commands**: a
  `cd` inside an added reading (`"$W" cd sub && rm x`, where `"$W"` may be
  `builtin`, so the shell would delete `sub/x`), `time cd sub; rm x` and a
  coproc `{ … }` body's statements read later commands from where they
  were. Named, pinned fail-opens for the protected-paths pack;
  `bounded/prereqs` refuses `"$W" cd sub && rm x` while a rule does not
  hold (its program name only the shell can resolve), and `time` and
  `coproc` once `shell-reader-coverage` reads them (the coproc body's code
  part, `time`'s report). Closing them would need a mechanism that
  multiplies readings at every such `cd`: not taken (the orchestrator's
  decision, for the maintainer).
- A range with a step of zero is unresolved only: no shell was recorded
  for it. A nested group whose range's `..` comes from inside its nested
  group's words (`f{1{..,x}3}`) gets the reading before (its rescan) and
  not bash 5's (outer braces kept); its outer group holds no `..` of its own.
- A literal cluster's value word was read as a wrapper's command before
  (`sudo -Eu root rm .env` ran `root`); it is now read as getopt reads it,
  the one place a literal word's earlier reading is replaced, since getopt
  leaves no doubt there.
- **What `programs` does not list** (*amended by `prereqs-execute`*; each
  until `shell-reader-coverage` where it fixes it): what programs and
  scripts run themselves; package runners (`npx`, `bunx`, `pnpm exec`,
  `yarn dlx`, `uvx`); a program named by its path (`/usr/bin/env terraform`,
  `/bin/bash -c …`), looked up by its full name, not its last segment;
  `time` and `coproc`; `trap`'s code and `alias` values; aliases and
  functions; git's `!` aliases; a script run through a shell or sourced;
  `-execdir`'s directory (read from where `find` runs).
- A pack judging writes must look in readings as well as write effects.
- `bounded/prereqs` matches `before: { execute }` and `before: { write }`
  against readings, and refuses where it cannot see (ADR 2026-019,
  amended).

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
    be left out; `OpenProjectHandler`'s (`bounded/application`) is gone too;
  - `JudgeEventHandler`'s `shellCommandReader`, `projectRoot` and
    `readWithinMs` options and its `DEFAULT_READ_WITHIN_MS` are gone;
  - `ExecuteEffect.reading` is never null, and `ExecuteEffectJSON.reading`
    is required;
  - `bounded/hosts/pi`'s `translate` gives the call before its readings
    (`PiCall`), and `piExtension` (its `ExtensionOptions`) takes a required
    `readShellCommand`.
- **Behaviour breaks:**
  - a host that sends an execute effect without a reading, as every 3.2.0
    host did, has each such call refused as an event that cannot be read,
    and recorded as invalid;
  - a tool result's execute effects must now carry a reading too, where
    3.2.0 refused one.
- **Changed by `shell-every-reading`:** the published conformance suite
  (`bounded/testing/shell-command-reader-conformance`) case "what only the
  shell can resolve is unresolved, never guessed" is now "…; a program it
  names may be a wrapper, so its words also run": `$TOOL x` lists `x []`
  after `$TOOL [x]`. Readings gain runs and parts (every reading adds), so
  a pack may refuse what it allowed: `bounded/prereqs` refuses
  `bash "$SCRIPT"`, `bash "$X" deploy.sh` and `bash "$S" "$1"` while a
  rule does not hold, and the protected-paths pack refuses the deletes
  those readings find.

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
