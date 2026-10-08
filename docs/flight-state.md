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
- **The install command** (issue #65, first slice): the `bounded` package's
  bin, `contexts/core/src/composition-root/bounded-cli-main.ts`.
  `bounded init` writes a `bounded.config.ts` selecting only the core pack
  (refusing if any `bounded.config.*` exists) and runs every host installer.
  `bounded update --from <dir>` upgrades the bounded packages from packed
  tarballs, then hands over to the newly installed CLI, which runs
  `bounded update --no-upgrade` (refresh the hooks only; idempotent; never
  writes the configuration). That hand-off is the contract between
  versions: every version must keep accepting `bounded update --no-upgrade`.
  Host installers are found at run time: each dependency whose package.json
  exports `./host-installer` (a `hostInstaller` implementing the core's
  `HostInstaller` contract) takes part; `bounded-claude-code` merges its
  hooks into `.claude/settings.json`, pointing at the project's own
  `node_modules/bounded-claude-code/src/main.ts`, and `bounded-pi` writes
  its loader when `.pi/` exists ([ADR 2026-015](adr/2026-015-host-installers.md);
  every installer runs the conformance suite
  `bounded/application/host-installer-conformance`). The end-to-end test
  (`contexts/core/test/bounded-cli.e2e.test.ts`) packs the workspace with
  `bun pm pack` and runs `npx bounded` against the tarballs.
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
    tarballs must override `bounded` with the local tarball (`overrides`),
    or its package manager resolves `bounded@0.1.0` on npm and fails. The
    first install sets that override by hand; `bounded update --from` then
    points it at each new tarball itself, checks every upgraded package's
    installed version against its tarball's, and restores `package.json`
    on any failure.
  - The Claude Code hook runs an absolute path. A moved or re-cloned
    project's stale hook (which blocks every call) is replaced by
    `bounded update`, whatever path it pointed at, but until then it
    blocks. A `.claude/settings.json` committed and checked out elsewhere
    therefore needs `bounded update` in each checkout. A command relative to
    `$CLAUDE_PROJECT_DIR` would avoid this. It was not adopted here because
    the slice's red-commit tests require the absolute path; it needs a
    decision and a superseded-tests record.
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
  - The CLI and its upgrade step live in the composition root
    (`bounded-cli.ts`, `package-upgrade.ts`), not a driving adapter under
    `src/adapters/in/cli/`: that would need a new export path, and the
    core's export paths are pinned by `architecture.test.ts`. The upgrade
    (package manager detection, running it, the hand-off) has no port of its
    own yet.
  - With bun, the upgrade rewrites the bounded packages' specs in
    package.json and runs `bun install`: `bun add` cannot replace one
    tarball dependency with another (bun 1.3.14 reports a dependency loop).
    npm, pnpm and yarn use their `add`/`install`; only bun is exercised end
    to end.
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
