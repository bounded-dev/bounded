# Flight state

Where the Bounded harness stands: what exists, what is known to be weak, and
what is not built yet. Each item was checked against the code and the docs
when written; keep it current (AGENTS.md, "Working with the user").

## 1. What exists

- **The core** (`contexts/core`, workspace package `bounded`): packs, typed
  extension points and composition ([slice 1](slice-1.md), ADRs
  [2026-002](adr/2026-002-typed-extension-points.md) to
  [2026-004](adr/2026-004-namespaced-pack-ids.md)); host-neutral events made
  of effects, verdicts and dispatch ([slice 2](slice-2.md), ADRs
  [2026-005](adr/2026-005-events-verdicts-dispatch.md) to
  [2026-007](adr/2026-007-guards-over-a-composition.md)); the
  [guard log](guard-log.md) ([ADR 2026-008](adr/2026-008-guard-log.md));
  project [configuration](configuration.md) (`bounded.config.ts`,
  [ADR 2026-010](adr/2026-010-project-configuration.md)). The core pack
  `bounded/core` declares the guard points and the lifecycle points
  `onProjectOpen`, `beforeTool` and `afterTool`; packs get adapters through
  ports the host provides ([ADR 2026-013](adr/2026-013-restructure.md)).
- **The path gate pack** (`bounded/path-gate`, [slice 3](slice-3.md),
  [ADR 2026-009](adr/2026-009-path-gate-pack.md)): deny-only protected
  paths on reads, listings and writes; a shell guard that parses each command
  with tree-sitter-bash and judges the files it names; [drift](drift.md)
  ([ADR 2026-011](adr/2026-011-drift.md)), which puts back what a shell
  command changed in protected files.
- **Host adapters** in `apps/`: [Claude Code](adapter-claude-code.md) hooks
  and a [pi](adapter-pi.md) extension.
- **The install command** (issue #65, first slice): the app `apps/cli`,
  package `bounded-cli`, bin `bounded`
  ([ADR 2026-016](adr/2026-016-cli-app.md)). The core keeps the
  `project-setup` features and their ports and adapters.
  - `bounded init --from <dir> [--host <host>]...` is the first install,
    run through npx. It adds `bounded`, `bounded-cli` and `bounded-<host>`
    as devDependencies, for each host found (`.claude/`, `.pi/`) or named.
    It overrides `bounded` (each package manager in its own way), checks the installed
    versions, and hands over to the installed `bounded init`.
  - `bounded init` writes a `bounded.config.ts` selecting only the core pack
    (refusing if any `bounded.config.*` exists) and runs every host
    installer.
  - `bounded update --from <dir>` upgrades the packages and moves the
    override. It then hands over to the installed
    `bounded update --no-upgrade`, which refreshes the hooks only, is
    idempotent and never writes the configuration.
  - The two hand-offs are the contract between versions: every version
    must keep accepting `bounded init` and `bounded update --no-upgrade`.
  - Host installers are found at run time: each dependency whose
    package.json exports `./host-installer` takes part
    ([ADR 2026-015](adr/2026-015-host-installers.md); every installer runs
    `bounded/testing/host-installer-conformance`).
    `bounded-claude-code` merges hooks running
    `bun "$CLAUDE_PROJECT_DIR/node_modules/bounded-claude-code/src/main.ts"`
    into `.claude/settings.json`. The file can be committed and works in
    every checkout, and older absolute-path entries are replaced.
    `bounded-pi` writes its loader when `.pi/` exists.
  - The end-to-end test (`apps/cli/test/bounded-cli.e2e.test.ts`) packs the
    workspace and runs the first install through npx against the tarballs,
    then `npx bounded update --from` against a later release.
- **A demo project** outside this repository, at `~/dev/bounded-demo` on the
  maintainer's machine: its `DRY-RUNS.md` records runs on both hosts; its
  `node_modules/bounded*` are symlinks into a checkout of this repository
  (they still point at the old `~/dev/bounded-core` checkout); its
  `scripts/install-bounded.ts` wraps the adapters' install helpers.

## 2. Known gaps and limits

- **The shell guard cannot see everything** ([ADR 2026-009](adr/2026-009-path-gate-pack.md),
  "Known gaps"; [slice 3](slice-3.md)): globs, variables and loop variables,
  `xargs` input, other-language scripts (`python -c`, `node -e`, `awk`,
  `perl -e`), what a script file or program opens itself, attached short
  options (`grep -f.env`) and brace expansion in a command name
  (`{cat,.env}`). Paths it cannot resolve are allowed. The real control is
  confining commands at the operating-system level (for example a sandbox
  profile, or the host's own Bash sandbox settings, generated from
  `protectedPaths`): planned, not built.
- **Interrupted tool calls are unchecked.** Pressing Esc in Claude Code fires
  no hook, so the change is never checked and its drift snapshot expires
  ([Claude Code adapter](adapter-claude-code.md), [drift](drift.md)).
- **Same-user limits** (the agent runs as the same OS user): a consistent
  forged snapshot wins ([drift](drift.md), [ADR 2026-011](adr/2026-011-drift.md));
  `.bounded/` (including the guard log), `node_modules` and `.git` are never
  watched, nor are git submodule contents ([drift](drift.md)); hard links out
  of the project are judged as inside it; check-then-use races; pi runs tool
  calls in parallel batches and offers no sequential mode
  ([Claude Code adapter](adapter-claude-code.md), [pi adapter](adapter-pi.md)).
- **Only `bounded.config.*` is protected**, not the modules it imports
  ([configuration](configuration.md); ADR 2026-009, "the configuration's
  imports"). Protecting the import closure is planned.
- **`invoke` effects pass** (MCP tools, skills, any tool the host cannot
  describe) unless a selected pack guards `invoke`; no shipped pack does
  ([ADR 2026-007](adr/2026-007-guards-over-a-composition.md)).
- **A `**`-led rule ending in a literal name refuses every project-wide
  listing or search.** Planned fix: an optional `exclude` on list effects
  (ADR 2026-009, Consequences); not built.
- **Deleting a parent folder of a file protected only by a `**`-led rule is
  allowed.** ADRs [2026-006](adr/2026-006-effects.md) and 2026-009 oblige
  adapters to describe a directory delete file by file, but neither adapter
  does: neither maps a tool to a delete, and the shell guard turns `rm -r dir`
  (or `git rm -r dir`) into one delete of `dir`. Only drift restores watched
  files afterwards.
- **A synchronously busy guard can overrun the Claude Code hook deadline.**
  The adapter's deadline bounds asynchronous work only
  ([Claude Code adapter](adapter-claude-code.md)).
- **Architecture rules guard against mistakes, not deliberate bypass**
  ([ADR 2026-013](adr/2026-013-restructure.md), rules R1 to R7). Spreading a
  genuine instance (`{ ...pack }`) is the one way past the compiler; the
  run-time parse refuses the copy
  ([ADR 2026-012](adr/2026-012-value-objects-are-classes.md)).
- **The install command's shortcuts** (issue #65, first slice):
  - `bounded update` with no `--from` refuses: nothing is published, and the
    npm package `bounded` is still the legacy harness (2.x, ADR 2026-014).
    Once this code is published, plain `bounded update` should install the
    latest release from the registry and hand over as `--from` does.
  - The packages are versioned `0.1.0`; publishing them as a new major above
    the legacy 2.x is still to decide. Until then a project installing from
    tarballs must override `bounded`, or its package manager resolves
    `bounded@0.1.0` on npm and fails. `init --from` and `update --from`
    write each manager's own override: `$bounded` for npm (`overrides`) and
    pnpm (`pnpm.overrides`), the tarball for bun (`overrides`) and yarn
    (`resolutions`). They check every installed version against its
    tarball's, and on any failure restore `package.json` and the lockfiles.
    npx must likewise be given bounded's tarball beside bounded-cli's.
  - bun and npm are exercised end to end. pnpm and yarn are not installed
    where this was built: their override fields and install command are
    unit-tested only.
  - Without a lockfile or a `packageManager` field, the package manager is
    the one in `npm_config_user_agent`. npx sets it from a shell, but keeps
    one it inherits: run from another manager's script (`bun run …`), the
    first install uses that manager.
  - `NodeModulesHostInstallerSource` refuses when a declared dependency is
    missing from `<root>/node_modules`: a devDependency left out
    (`--production`), or a workspace that hoists packages to a parent
    directory. It reads only `<root>/node_modules`.
  - **An agent running `bounded update --from` can swap out the hook's own
    code**: it installs whatever tarballs it is given, and the new version's
    CLI and hooks run from then on. Nothing guards that command yet; a
    project must guard it (for example, protect `package.json`,
    `node_modules/` and the lockfile, or refuse the command, in its packs'
    rules) until a shipped pack does.
  - Hooks run TypeScript under bun (`bun …/src/main.ts`); the packages ship
    their `.ts` sources. Compiled JavaScript for node is not built.
  - In `apps/cli`, installing (package manager detection, running it, the
    hand-off) is plain code in `bounded-cli.ts` and `package-upgrade.ts`,
    not a feature with ports.
  - `init --from` maps a host to its package by the convention
    `bounded-<host>`, and finds hosts only by `.claude/` and `.pi/`.
  - Every manager installs from the rewritten package.json with its plain
    `install`: `bun add` cannot replace one tarball dependency with another
    (bun 1.3.14 reports a dependency loop), and npm's add checks the
    `$bounded` override before the dependency exists (EOVERRIDE).
  - `isBoundedHook` recognises bounded's Claude Code hook by its path and
    skips any hook with `--role`. So a stale `--role` hook at a dead absolute
    path (from an older install, before a move) is kept, and blocks every
    call until it is removed by hand. And a deliberate role-less bounded
    hook with a narrower matcher (say, only `Bash`) is removed by
    `bounded update`, which installs the one for every tool.
  - A project's root is the directory the command runs in; it is not
    searched for upwards.
- **A pack id naming its own npm package is checked only by an architecture
  test** (`architecture.test.ts`). The load-time check belongs to a
  file-backed pack catalog, which does not exist yet
  ([ADR 2026-004](adr/2026-004-namespaced-pack-ids.md)).

## 3. Not built yet

- Roles, and path rules per role ([spec](spec.md)); adapters pass a role
  label through, but nothing uses it.
- A tool allowlist pack: shaping the tools offered at session start, with a
  `toolUseGuards` backstop (the point exists; no pack contributes).
- Skills, role briefs and instruction projections written at install.
- Beyond `bounded init` and `bounded update` (see "The install command"
  below), no other command-line tool exists.
- A file-backed pack catalog (only the in-memory catalog exists).
- A workflow or phase state pack.
- Per-pack typed configuration, static (data) contribution lists, point
  summaries, and a provenance view of who contributed what.
- A redaction hook for the guard log ([guard log](guard-log.md),
  [ADR 2026-008](adr/2026-008-guard-log.md)).
- Publishing `bounded` to npm as a new major version
  ([ADR 2026-014](adr/2026-014-legacy-harness-moves-to-legacy.md)).
- Archiving the private repository this code was first built in, now that
  it lives here.
- Triage of this repository's open issues, written against the legacy
  harness.

## 4. Notes on the lifecycle tooling

How `scripts/workflow/red-first-check.ts` ([development workflow](development-workflow.md))
behaves in practice:

- A supersession record in `superseded-tests.json` names the test file by
  the path it had at the red commit being checked. Renames after that are
  followed only to find the file at the head; a case moved into an
  unrelated file is not detected.
- A test that already passes before the fix cannot be red: put it in the
  build commit, not the red commit.
- The preserved check reads supersession records from the head commit only;
  a record added in a later commit counts once it is at the head.
