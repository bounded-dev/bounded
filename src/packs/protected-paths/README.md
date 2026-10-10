# bounded/protected-paths: deny-only rules on what agents read, list and write

A pack shipped in `bounded` ([ADR 2026-009](../../../docs/adr/2026-009-path-gate-pack.md),
named `bounded/path-gate` until 3.3.0, [ADR 2026-021](../../../docs/adr/2026-021-protected-paths-rename.md)).
It ships no rules of its own: a project, or a pack that depends on it,
contributes them. `bounded init` writes seven default rules into the
project's configuration, where the project can see and change them.

## What it is for

Keeping agents away from the files a project says they must not touch:
secrets they must not read, generated code they must not edit by hand,
history they must not rewrite, and the files that set up Bounded itself.
Each rule denies some accesses to the paths it matches and tells the agent
what to do instead. There are no allow rules, so a denial from any rule
wins.

## Rule shape

Projects and packs contribute rules to the pack's one point,
`protectedPaths`. A rule is:

- `match`: a project-relative glob. It ignores case and sees dotfiles. A
  pattern ending in a literal name also covers everything under that name
  (`packages/db` protects the whole directory); never end one in `/`.
- `except` (optional): globs, matched exactly, for paths the rule leaves
  alone. An exception never reaches another rule.
- `deny`: one or more of `read`, `list`, `create`, `modify` and `delete`.
  There is no `write`: name each write. Denying `modify` needs `create` or
  `delete` too.
- `redirect`: what the agent is told to do instead.
- `why` (optional): the reason, shown with the refusal.
- `file` (optional): `true` when the match names files only, not what is
  under them. A search filtered to other names (`*.ts`) then cannot reach
  it, so it is allowed.

Patterns are never absolute, never hold `..`, are never negated or
parenthesised (write alternatives with braces, `{a,b}`), and are at most 512
characters. Prefer literal last parts or pure suffixes (`**/.env`,
`**/*.pem`) to open globs (`**/.env*`): a listing's filter can rule a
suffix out. A rule that cannot be read is refused when the project is
composed, naming the pack that contributed it.

## Workflows it fits

- **Secrets:** environment files, private keys and a `secrets/` folder an
  agent may neither read nor write.
- **Generated code:** a folder written by a generator, with its notes left
  editable, whose redirect says which input to change and what to run.
- **History:** applied migrations, which may be added to but never changed
  or deleted.
- **The guardrails themselves:** the project's configuration, Bounded's
  state in `.bounded/`, the hooks that run Bounded and git's hooks and
  config. `bounded init`'s defaults cover these; other packs rely on them
  (`bounded/prereqs` keeps its records in `.bounded/`).

## What it observes

- **File tools:** each read, listing and write a host describes as an
  effect, judged against every rule, in pack order; the first rule that
  denies refuses, naming its match and the pack that contributed it, with
  its redirect. A listing or content search is refused when it could reach
  a path a rule denies, with a narrower root or filter as the redirect. A
  delete is refused when the path could hold a path a rule denies delete
  for.
- **Shell commands:** the reading the host adapter made of each command
  ([ADR 2026-020](../../../docs/adr/2026-020-shell-command-reading.md)): the
  files it reads, lists and writes, each judged exactly as a file tool's.
  A command bounded could not read, or one past the reader's bounds, is
  refused.
- **Drift, around every allowed shell command**
  ([ADR 2026-011](../../../docs/adr/2026-011-drift.md), [drift](../../../docs/drift.md)):
  before the command runs, the files that rules deny writes to are
  snapshotted (its `beforeTool` check); after it, any change a rule denies
  is put back and reported (its `afterTool` check). A command whose
  snapshot cannot be taken is refused.

Fetch, delegate and invoke effects are not judged by path.

## What it cannot see

- **What only the shell can resolve** is not guessed at, and is allowed:
  globs, variables, `~`, paths outside the project, and files a program or
  script opens by itself. A write only the shell can name (`cp "$X" dir/`)
  is allowed; so is a later command after a `cd` the reading cannot place
  (`"$W" cd sub && rm x`). Drift undoes what such a command changes in
  watched files.
- **What the shell command reader does not see**
  ([ADR 2026-020](../../../docs/adr/2026-020-shell-command-reading.md),
  "Limits"): in-place edits (`sed -i`, `perl -i`), other-language code
  (`python -c`, `node -e`), `git config …` (seen as a read), writes delayed
  into the background, brace expansion in a command name (`{cat,.env}`),
  and PowerShell, read as bash.
- **Snapshots in the user's state directory,** which an agent running as
  the same user can write.
- **What drift never watches:** `.bounded/`, every `node_modules/` and
  `.git/` directory, and the contents of git submodules. A forged but
  consistent snapshot wins.
- **Deleting a parent folder** of a file protected only by a `**`-led rule
  is allowed; only drift puts the files back.
- **A `**`-led rule ending in a literal name** refuses every project-wide
  listing or search; search a narrower root.
- **The configuration's imports:** a rule on `bounded.config.*` protects
  that file, not the modules it imports.
- **Outside the project:** `~/.claude/settings.json` and anything else
  outside the project root cannot be protected. Hard links out of the
  project are judged as inside it.

This is not a security boundary: pair it with the host's sandbox.
Confining commands at the operating-system level is planned, not built.

## Ports

A host provides both, through `openProject(root, { ports:
protectedPathsPortProvisions() })` (`bounded/protected-paths/adapters`); the
hooks for Claude Code and pi that `bounded` carries do.

- `watchedFiles` (`WatchedFiles`): the files the rules watch, their
  hashes, the commit checked out, and putting a file back.
- `shellSnapshots` (`ShellSnapshots`): each shell call's snapshot, kept by
  call id in the user's state directory (`$XDG_STATE_HOME`, else
  `~/.local/state`) between its `beforeTool` and `afterTool` checks.

## Examples

Each is a complete `bounded.config.ts`, in `examples/`, opened as a
project's configuration by the package's tests.

- `keep-secrets-out.config.ts`: environment files, private keys and
  `secrets/` that agents may neither read nor write, with file rules so a
  filtered search still works.
- `guard-the-guardrails.config.ts`: the configuration, Bounded's state, the
  hooks and git's hooks protected, generated code changed only through its
  generator, and migrations that may be added but never changed.
