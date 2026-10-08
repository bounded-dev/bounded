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
- **One package, `bounded` 3.0.0, ready to publish** (issue #65, first slice;
  [ADR 2026-016](adr/2026-016-cli-app.md)). It carries the library, the path
  gate, the `bounded` command (source `apps/cli`) and the Claude Code and pi
  adapters (sources `apps/claude-code`, `apps/pi`). The three apps are
  private, and `bounded`'s prepack (`contexts/core/build-dist.ts`) compiles
  them with the library to JavaScript for Node in `dist/`. Nothing needs bun
  at run time (Node 22.18 or later). The publish itself waits for review:
  [releasing](releasing.md).
  - `npx bounded init [--host <host>]...` adds `bounded` at the CLI's own
    version from the npm registry, with the project's package manager. It
    then hands over to the installed `bounded init --no-install`, which:
    - writes `bounded.config.ts`: the core, the path gate, and five default
      rules, since the pack ships none
      ([ADR 2026-009](adr/2026-009-path-gate-pack.md)). They protect
      `bounded.config.*`, `.bounded/`, `.claude/settings.json`,
      `.pi/extensions/bounded/**` and `node_modules/bounded/**` from every
      write;
    - runs `bounded`'s bundled installers for the hosts named or found
      (`.claude/`, `.pi/`), and any third-party package's `./host-installer`
      ([ADR 2026-015](adr/2026-015-host-installers.md)).
  - `npx bounded update` drops any `--from` override of `bounded`, upgrades
    it to its latest, and checks it is at least the version the package
    manager resolved (so a pin is refused) and not older than before. It
    then hands over to the installed `bounded update --no-upgrade`. That
    refreshes the hooks of the bundled hosts bounded is already installed
    for (never adding one), and any third-party installer. It is
    idempotent and never writes the configuration. Any failed install
    restores `package.json` and the lockfiles.
  - The hand-offs are the contract between versions: every version must
    keep accepting `bounded init --no-install [--host <host>]...` and
    `bounded update --no-upgrade`.
  - `--from <dir>` installs or upgrades from `bounded`'s packed tarball, for
    local development (README, "From a checkout").
  - The Claude Code hook runs
    `node "$CLAUDE_PROJECT_DIR/node_modules/bounded/dist/hosts/claude-code/hook.js"`,
    so `.claude/settings.json` can be committed. Earlier forms (bun, the
    `bounded-claude-code` package, absolute paths) are replaced. pi's
    loader imports `bounded/hosts/pi`.
  - `bounded.config.ts` loads under Node whatever the project's `"type"`
    (a load hook), and a Node that cannot strip types fails closed with
    what to do.
  - The end-to-end test (`apps/cli/test/bounded-cli.e2e.test.ts`) packs
    `bounded` and installs it with bun and with npm. The npm run has no bun
    on `PATH`: it pipes Claude Code payloads through the installed hook
    command under `sh`. The path gate refuses an edit of the configuration
    (init's default rule) and of `secrets/` (a project rule), allows another
    edit, and refuses `echo hi > secrets/x`, which shows tree-sitter loading
    under Node.
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
- **Only `bounded.config.*` is protected**, by the default rule `bounded init`
  writes into the configuration (the path gate ships none; a project that
  removes it protects nothing), and not the modules it imports
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
- **The install command's limits** (issue #65, first slice):
  - The default rule for `node_modules/bounded/**` refuses only writes the
    path gate sees: an edit, or a shell command naming the path. Drift never
    watches `node_modules` (see [drift](drift.md)), so an agent's
    `npm install` changing Bounded's installed code is not put back. Drift
    does put back what a shell command changed in `.claude/settings.json`
    and `.pi/extensions/bounded/**` (the npm end-to-end case shows it for
    the settings). An agent's `bounded update` therefore has its settings
    change undone while package.json, the lockfile and node_modules keep the
    new version. Measured: the rule adds no time to a Bash Pre and Post
    round through the bundled hook (median 318 ms with and without; mostly
    two Node starts).
  - Not yet published. npm's `bounded` is the legacy 2.x until 3.0.0 is
    published ([ADR 2026-014](adr/2026-014-legacy-harness-moves-to-legacy.md)).
    Until then, installs need `--from` and npx needs the tarball. A
    `--from` install overrides `bounded` in `package.json`, each package
    manager in its own field: `$bounded` for npm (`overrides`) and pnpm
    (`pnpm.overrides`), the tarball for bun (`overrides`) and yarn
    (`resolutions`).
  - bun and npm are exercised end to end. pnpm and yarn are not installed
    where this was built: their commands and override fields are
    unit-tested only.
  - Without a lockfile or a `packageManager` field, the package manager is
    the one in `npm_config_user_agent`. npx sets it from a shell, but keeps
    one it inherits: run from another manager's script (`bun run …`), the
    first install uses that manager.
  - `NodeModulesHostInstallerSource` refuses when a declared dependency is
    missing from `<root>/node_modules`, such as a devDependency left out
    (`--production`) or a workspace that hoists packages to a parent
    directory. It reads only `<root>/node_modules`.
  - **An agent running `bounded update` can swap out the hook's own code**:
    it installs whatever version (or, with `--from`, tarball) it is given,
    and the new version's CLI and hooks run from then on. Nothing guards
    that command yet. A project must guard it until a shipped pack does,
    for example by protecting `package.json`, `node_modules/` and the
    lockfile, or by refusing the command, in its rules.
  - The pack-time build mirrors `src/` in `dist/` (for example
    `dist/packs/path-gate/index.js`). The workspace uses bun's hoisted
    linker: bun mis-resolved the conditionally exported package through
    several workspace symlinks.
  - In `apps/cli`, installing (package manager detection, running it, the
    hand-off) is plain code in `bounded-cli.ts` and `package-upgrade.ts`,
    not a feature with ports. Hosts are found only by `.claude/` and `.pi/`.
  - `isBoundedHook` recognises bounded's Claude Code hook by its path, and
    skips any hook with `--role`. That has two effects:
    - A stale `--role` hook at a dead absolute path (from an older install,
      before a move) is kept, and blocks every call until it is removed by
      hand.
    - A deliberate role-less bounded hook with a narrower matcher (say, only
      `Bash`) is removed by `bounded update`, which installs the one for
      every tool.
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
- Publishing `bounded` 3.0.0 to npm, the new major above the legacy 2.x
  ([ADR 2026-014](adr/2026-014-legacy-harness-moves-to-legacy.md)): the
  package is ready ([releasing](releasing.md)); the publish waits for review.
- Declaration files (`.d.ts`). TypeScript consumers read the shipped sources
  through `types`, and those import each other with `.ts` extensions, so a
  consumer's `tsc` that checks them needs `allowImportingTsExtensions`; without
  it, TS5097 (packaging.test.ts pins both). Emitting declarations fails on one
  inferred type in `domain/packs/pack.ts` (TS7056) that needs an explicit
  annotation first.
- Loading `bounded.config.ts` on Nodes older than 22.18: they are refused,
  told to upgrade or to write `bounded.config.mjs`.
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
