# 2026-009: The path gate is an ordinary pack shipped in `bounded`

**Status:** accepted. A rule is a class, not a frozen plain object, since
[ADR 2026-012](2026-012-value-objects-are-classes.md); rules are still
written as object literals (its wire form).

## Decision

- **Where it lives.** The path gate, `bounded/path-gate`, ships in the npm
  package `bounded` (so `packIdsFor("bounded")`), in its own directory
  `contexts/core/src/packs/path-gate/`, exported as `bounded/path-gate`. It is
  an ordinary pack: it depends on `corePack` and uses only `bounded/domain`,
  its own files and the libraries the package declares (picomatch). Nothing
  outside its directory imports it except tests under the context's
  composition root (`src/pack/`), so the core never depends on it.
  `architecture.test.ts` enforces this for every directory under `src/packs/`
  (the "shipped pack" rule; `packs/` holds shipped packs, `pack/` is the
  composition root), and takes an export path's layer from the file it
  points at.
- **Rules are deny-only.** The point `protectedPaths` takes
  `{ match, except?, deny, redirect, why?, file? }`. `deny` is a non-empty list of
  `read`, `list`, `create`, `modify`, `delete`, each named: there is no
  shorthand for every write (an exported `writes` list was removed as
  unclear), so a rule reads as exactly what it stops (the spec's coarse
  "read, write or both" became precise effect kinds, ADR 2026-006). A rule denying `modify` must also deny `create` or `delete`, or
  a delete and a create would change the file. There are no allow rules:
  any rule that denies refuses. A rule's `except` carves paths out of that
  rule only, and may not cover the whole match (identical, or `**`).
- **Patterns are checked, never hand-matched.** picomatch compiles every
  glob (strict brackets, no extglobs). The check refuses empty, absolute,
  negated (`!`, use `except`), `..`-using and backslashed patterns,
  parentheses (extglobs and regex groups; braces cover real needs), a `/` or
  `**` inside a group (so a pattern splits into its path parts at every
  `/`), a trailing `/`, and patterns over 512 characters. It tidies `./`,
  `//` and Unicode form. A redirect and a why hold no control characters and
  at most 1000 characters.
- **Matching.** Matching sees dotfiles; `match` ignores case (so a rule
  cannot be dodged on case-insensitive file systems), `except` does not (so a
  carve-out never grows). A match ending in a literal name also covers
  everything under that name, as in .gitignore: `packages/db` protects
  `packages/db/x.ts`. A match ending in a glob covers only what it matches.
  A **file rule** (`file: true`, stored only when true) covers exactly the
  paths its match names, never what is under them: `{ match: ".env", file:
  true }` protects the file `.env`, so a filter that cannot match the name
  (`*.ts`) keeps a search of the whole project away from it. Directory
  semantics stay the default.
- **Per effect.** `read`, `create` and `modify` are judged by the exact path.
  `list` is judged conservatively: refused when the root, or anything below
  it, could be a path the rule applies to, walking the rule's parts along the
  root's (a part holding `**` spans any number of parts). An `except` helps
  only when it ends in `**` and covers the whole root. A filter helps only
  when it provably cannot name a path the rule ends in: a literal filter the
  rule's last part does not match, or two pure literal suffixes (`*.pem`,
  `*.ts`) or prefixes (`key*`, `id*`) neither of which extends the other. A
  filter with `/` or `**` proves nothing, and two other globs may share a name
  (`.env*` and `*.tsx` both match `.env.tsx`). A rule ending in a literal name
  covers that name's contents, so no filter rules it out, unless it is a file
  rule: then the filter is asked whether it matches the name. A read over a root
  the same call lists (compared ignoring case) is a content search, judged as
  reaching everything the listing could. A `delete` is also refused when the
  path could hold a path the rule denies delete for, walking the rule only up
  to its first spanning part, since the guard cannot know whether the path is
  a directory: `packages/db/**` refuses deleting `packages`, and deleting `.`
  is always refused, but `**`-led rules do not refuse every delete. Fetch,
  delegate and invoke are not judged by path.
- **Shell commands: parsed, translated, then judged as file tools are.**
  The execute guard decides nothing itself. A **parser port**
  (`ShellParser`, `shell-command.contract.ts`) turns a command line into a
  syntax tree of the port's own: commands (name, words, redirections,
  assignments), lists (`;`, `&&`, `||`, `&`), pipelines, subshells, groups,
  conditionals (if, loops, case, functions) and text it could not read.
  Words are literal (quotes and escapes removed) or unresolved, carrying the
  commands substituted in them (`$()` and backquotes). A **pure translation**
  (`describeShellCommand`, `shell-command.ts`) walks the tree with the
  effect's `cwd` into `{ reads, lists, writes, unresolved }`:
  - Where each command runs is followed as the shell would: `cd` and `pushd`
    carry on to later commands in the same shell, never out of a subshell, a
    substitution, a background command or a pipeline stage; after `popd`,
    `cd -`, `cd` alone, a target that cannot be resolved or lies outside the
    project, or a cd that may or may not have run (inside an if or a loop, on
    the left of `||`), where later commands run is unknown and their
    relative paths are unresolved. `builtin`, `command`, `exec`, `xargs`
    (its literal arguments) and `find -exec` are looked past. A shell given
    code with `-c` (`sh`, `bash`, `zsh`, `dash`, `ksh`) has that code parsed
    and walked as a nested command line, in a shell of its own.
  - Words: brace expansion of literals (`{a,b}`, `{1..3}`, `{a..e}`,
    nested, at most 256 words) gives each word, as the shell would; braces
    inside quotes are text. `$'…'` strings with simple escapes (`\n`, `\t`,
    `\'` …) are literal; with `\x`, `\u`, octal or `\c` they are
    unresolved. `$(< file)` reads the file.
  - Redirections: `<` reads; `>`, `>>`, `>|`, `&>`, `&>>` and `>&` to a file
    write; `<>` both; `>&1`-style duplications, heredoc bodies and
    here-strings are text, though commands substituted in them still run.
    A write is a create when the file is missing and a modify when it exists,
    exactly as for the Write tool, asked through a file-existence port; when
    that cannot be told it is judged as both, and the refusal says so.
  - **What each command does with its arguments** is a small explicit table
    (`command-meanings.ts`, its contract in `command-meanings.contract.ts`):
    `ls`, `tree` and `find`'s roots list (where it runs when none is given);
    `echo`, `printf`, `test`/`[`/`[[`, `true`, `false` and the shell's
    declaration and job builtins name nothing; `touch` creates a missing file
    (an existing one's content is not changed); `mkdir` creates; `rm`,
    `rmdir`, `unlink` delete; `cp` and `mv` read their sources (content
    moves to a new name) and `mv` deletes them, both writing the destination
    (inside it by name when it is a directory); `tee` writes its operands;
    `dd` reads `if=` and writes `of=`; `curl` reads the files its data and
    form options name with `@` (or `<`), and `-T`, writes `-o`, and its URLs
    name no project file; `git add` stages (nothing), `git rm` deletes (but
    `--cached`), `git mv` moves, other git subcommands read their operands,
    a `<rev>:<path>` operand (`git show HEAD:.env`, `git show :.env`) reads
    the path from the repository root (when the project root holds `.git`;
    unresolved otherwise) or from where it runs when written `./` or `../`,
    and paths given with `git -C` are unresolved; `eval`'s code is
    unresolved. **Any other
    command reads every operand and every `--option=value`'s value** (the
    conservative default). Short options with an attached value (`grep
    -f.env`) are a known gap.
  - Absolute paths inside the project root are project paths; outside, as
    with `~`, variables and globs, they are unresolved.
  Each read, listing and write is then judged by the same functions as the
  read, list and write guards (`readDenial`, `listDenial`, `writeDenial`), so
  rules, `except`, file rules, case and messages are identical; the refusal
  reads "this command reads '.env' — <the read guard's refusal>" with the
  rule's redirect. **Unresolved is never guessed at**: it is allowed, and so
  is anything a program or script opens by itself; confining commands at the
  operating-system level is the real control (planned), and the drift check
  (ADR 2026-011) still undoes writes to watched files afterwards.
  **Known gaps**, all out of reach of a static check: what `xargs` reads
  from its input; loop variables (`for f in .env; do cat $f; done`);
  environment variables and other expansions that hold paths; globs;
  scripts in other languages (`python -c`, `node -e`, `awk`, `perl -e`) and
  the files any program or script opens by itself; short options with an
  attached value (`grep -f.env`); a brace expansion in a command's name
  (`{cat,.env}`), which the grammar does not parse as a command.
  **Preparation:** guards are synchronous, but loading a parser is not. So
  the core gives packs a point, `onProjectOpen` (ADR 2026-010), run once by
  `openProject` before any event is judged, given the project's root and a
  way to ask what is at a path. The path gate loads its parser there (once
  per program) and keeps, per composition, the root and the existence port
  for its check. Each such preparation is bounded (5 seconds by default,
  `prepareWithinMs`): one that has not finished counts as failed, the
  project opens, and the path gate refuses shell commands while its parser
  is still loading ("the shell parser could not load (… timed out)"). A command that cannot be checked at all, because the
  project was not opened with `openProject` or the parser could not load, is
  refused with what to do (fail closed).
  The ports speak the core's value objects (ADR 2026-012): the parser takes
  a `Command`; where a command runs, the paths it reads, lists and writes and
  the paths the existence port is asked about are `ProjectPath`s; the syntax
  tree and the table's records are plain data.
  **Placement:** the syntax tree, the translation and the table are pure,
  inside the path gate pack, with the parser behind its port (the core names
  no parser); the planned restructure can give the path gate its own hexagon
  with these in its domain and the parser as an adapter.
  **The parser:** tree-sitter's bash grammar compiled to WebAssembly, from
  `@vscode/tree-sitter-wasm`, pinned at 0.3.1: Microsoft's package of
  prebuilt grammars with the web-tree-sitter runtime, WebAssembly only (no
  native addon, no install script, no dependencies). It loads asynchronously
  once and then parses synchronously, and runs under Bun, node and pi's
  jiti. It supersedes shell-quote (a tokeniser: the translation had to guess
  structure it did not have). `sh-syntax` (mvdan/sh) was the other full
  parser considered: its API instantiates WebAssembly asynchronously on every
  parse, which a synchronous guard cannot wait for. `tree-sitter-bash`
  itself ships a native addon and install script; `mvdan-sh` is deprecated;
  `bash-parser` has not been released since 2022.
- **Provenance and redirects.** A refusal names the path (via dispatch's
  prefix), the rule's `match`, the pack that contributed the rule (from the
  composition's entries) and the rule's `why`. The redirect is the rule's;
  a listing or search refusal composes its own: "List (or Search) a root
  outside '<match>' — <rule's redirect>", or for the project root "List (or
  Search) a narrower path (not the whole project) that cannot reach
  '<match>' — …". Where a filter can help (the rule's last part names the
  files: a one-part glob or a file rule's name) it adds ", or give a filter
  that cannot match '<match>'". When several rules deny, the first in pack order is named.
- **Its own guardrails.** The path gate gives its own point two rules:
  every write to `**/bounded.config.*` (any depth, any extension a loader
  might pick up) and to `.bounded/**` is refused. They are ordinary rules,
  listed with the rest and named in refusals. Adapters write the guard log
  in `.bounded/` directly, not through guards.

## Why

A gate in the core would give the core an opinion; as a pack it is selected
like any other and proves the extension mechanism. Deny-only with
rule-owned exceptions means no pack can weaken another's protection.

## Consequences

- ~~A rule is a frozen plain object, not a class with a private
  constructor.~~ Superseded by ADR 2026-012: `ProtectedPath` is a class, and
  contributions are written as object literals of its wire form
  (`ProtectedPathJSON`), which the point's check parses.
- `**`-led rules make listings and searches across the project refused
  unless the root is outside their reach or a filter provably excludes them.
  Rule authors should prefer literal last parts or pure suffixes
  (`**/.env`, `**/.env.local`, `**/*.pem`) to open globs such as `**/.env*`.
- **Known gap: the configuration's imports.** Only the configuration's entry
  file is protected. What it imports (project pack modules, `package.json`,
  the lockfile, `node_modules/bounded`) can still be changed by an agent and
  so change the guardrails. The loader slice closes this: it computes the
  configuration's import closure and protects it, or requires project packs
  to live under `.bounded/`.
- **Adapters describe directory deletes file by file.** It is an adapter
  obligation (ADR 2026-006) that deleting or renaming a directory reaches the
  gate as one write effect per file it contains, plus one for the directory
  itself; `contains()` stays as a backstop for an adapter that sends only the
  directory. Without that, deleting `apps` is not refused for a file only
  `**/.env` protects. Shell deletes are covered by the hash-check slice.
- **Wildcards per part.** More than three `*` or `?` in one part of a pattern
  are refused: picomatch backtracks polynomially on a long name
  (`**/*a*a*a*a*b` took seconds on 255 characters), and a guard must stay fast.
- **Honest redirects.** A `**`-led rule ending in a literal name (not a file rule) reaches
  every listing and search (its name may be a directory of any file), so its
  refusals say no listing or search can avoid it, and to name or read the
  files directly or ask a person, instead of suggesting another root.
- **Planned: `exclude` on the list effect** (a core change, its own ADR). A
  host whose search skips paths (for example ignored or hidden files) could
  say so on the list effect, and the path gate could then allow a listing
  whose excludes provably cover a rule. Not built.
- Role path rules (spec Part 3) are a later slice.
