# Flight state

Where the Bounded harness stands: what exists, what is known to be weak, and
what is not built yet. Each item was checked against the code and the docs
when written; keep it current (AGENTS.md, "Working with the user").

## 1. What exists

- **The core** (`src/core`, in the workspace package `bounded` at `src`, ADR 2026-024): packs, typed
  extension points and composition ([slice 1](slice-1.md), ADRs
  [2026-002](adr/2026-002-typed-extension-points.md) to
  [2026-004](adr/2026-004-namespaced-pack-ids.md)); host-neutral events made
  of effects, verdicts and dispatch ([slice 2](slice-2.md), ADRs
  [2026-005](adr/2026-005-events-verdicts-dispatch.md) to
  [2026-007](adr/2026-007-guards-over-a-composition.md)); the
  [Bounded log](bounded-log.md) ([ADR 2026-022](adr/2026-022-bounded-log.md));
  project [configuration](configuration.md) (`bounded.config.ts`,
  [ADR 2026-010](adr/2026-010-project-configuration.md)). The core pack
  `bounded/core` declares the guard points and the lifecycle points
  `onProjectOpen`, `beforeTool`, `afterTool` and `onAgentRunFinish`; packs
  get adapters through ports the host provides
  ([ADR 2026-013](adr/2026-013-restructure.md),
  [ADR 2026-025](adr/2026-025-agent-run-finish.md)).
  A selection brings in every pack its listed packs depend on, transitively
  ([ADR 2026-018](adr/2026-018-selection-brings-in-dependencies.md)); the
  project still contributes only to points of packs it lists.
- **Out adapters grouped by the port they serve**
  ([ADR 2026-017](adr/2026-017-adapters-by-port.md)): one folder per port
  under `adapters/out/`, in the core and the protected-paths pack, behind two internal
  export paths, `bounded/adapters` and `bounded/protected-paths/adapters`. The
  in-memory doubles are test support beside their ports. The `Clock` and
  `DecisionIds` ports give `DecisionTime` and `DecisionId` value objects, and
  `openProject` passes `RandomDecisionIds`. This breaks what 3.0.0
  published (its six adapter export paths, the in-memory doubles,
  `pathGateInMemory`, string-typed clock and ids), shipped deliberately as
  the minor 3.1.0 because 3.0.0 was about an hour old with no users (the
  ADR's "Release").
- **The protected-paths pack** (`bounded/protected-paths`, [slice 3](slice-3.md),
  [ADR 2026-009](adr/2026-009-path-gate-pack.md)): deny-only protected
  paths on reads, listings and writes; a shell guard that judges the files
  a command names from the reading its execute effect carries; [drift](drift.md)
  ([ADR 2026-011](adr/2026-011-drift.md)), which puts back what a shell
  command changed in protected files.
- **Shell commands read once, by the host adapter**
  ([ADR 2026-020](adr/2026-020-shell-command-reading.md), corrected in
  3.3.0): the host adapter, trusted code, reads every execute effect's
  command from the model's tool input when it builds the core's event, and
  the effect carries the reading (the programs it runs, the files it reads,
  lists and writes, and what only the shell could resolve), required, its
  shape checked by the core. The reader, tree-sitter-bash and the table of
  what commands do with their words are a private context,
  `bounded-shell-command-reader` (`src/lib/shell-command-reader`), built
  into `bounded` as `bounded/shell-command-reader`
  (`openShellCommandReading`); both hosts prepare it once and read with it,
  for each call and again for its result, within their decision deadlines,
  and its conformance suite is published as
  `bounded/testing/shell-command-reader-conformance`.
- **The prerequisites pack** (`bounded/prereqs`,
  [ADR 2026-019](adr/2026-019-prereqs-pack.md), [its README](../src/packs/prereqs/README.md)),
  shipping in 3.2.0: a project's rules make an action (a
  delegation to an agent, or a file tool's write a pattern matches) wait
  until a delegation to another agent has succeeded over files unchanged
  since. Its records and starts are in `.bounded/prereqs/`; its two ports
  are provided by both hosts. The core's delegate effect carries `isolated`
  and `finishUnreported`, and a tool result `delegatedAgentRuns`: only a run
  the host says finished counts, as the agent the host resolved
  (`require` matches it exactly). From 3.3.0 a background run counts at its
  finish: the core's `AgentRunFinished`, from Claude Code's SubagentStop,
  reaches the pack through `onAgentRunFinish`, and until then an action
  waiting on it is refused as pending
  ([ADR 2026-025](adr/2026-025-agent-run-finish.md)).
- **Host adapters** in `src/hosts/`: [Claude Code](adapter-claude-code.md) hooks
  and a [pi](adapter-pi.md) extension.
- **One package, `bounded` 3.3.0, ready to publish; 3.2.0 is published**
  (issue #65, first slice;
  [ADR 2026-016](adr/2026-016-cli-app.md)). It carries the library, the protected-paths
  pack, the `bounded` command (source `src/cli`) and the Claude Code and pi
  adapters (sources `src/hosts/claude-code`, `src/hosts/pi`). The three apps are
  private, and `bounded`'s prepack (`src/build-dist.ts`) compiles
  them with the library to JavaScript for Node in `dist/`. Nothing needs bun
  at run time (Node 22.18 or later). The publish itself waits for review:
  [releasing](releasing.md).
  - `npx bounded init [--host <host>]...` adds `bounded` at the CLI's own
    version from the npm registry, with the project's package manager. It
    then hands over to the installed `bounded init --no-install`, which:
    - writes `bounded.config.ts`: the protected-paths pack (which brings in the core),
      and seven default rules, since the pack ships none
      ([ADR 2026-009](adr/2026-009-path-gate-pack.md)). They protect
      `bounded.config.*`, `.bounded/`, `.claude/settings*.json`,
      `.pi/extensions/bounded/**`, `node_modules/bounded/**`,
      `.git/hooks/**` and `.git/config` from every write;
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
  - Both end with a restart notice per host (3.1.1), none for a host
    skipped. Claude Code's sessions restart only when init set it up or its
    settings changed; otherwise a line says the new `bounded` is live on
    their next tool call. pi's sessions, and a third-party host's, are told
    to restart every time: the CLI cannot know which `bounded` a running
    session loaded.
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
  - The end-to-end test (`src/cli/test/bounded-cli.e2e.test.ts`) packs
    `bounded` and installs it with bun and with npm. The npm run has no bun
    on `PATH`: it pipes Claude Code payloads through the installed hook
    command under `sh`. The protected-paths pack refuses an edit of the configuration
    (init's default rule) and of `secrets/` (a project rule), allows another
    edit, and refuses `echo hi > secrets/x` and
    `echo x > .git/hooks/pre-commit`, which shows tree-sitter loading under
    Node. The bun run sends that Bash call through the installed hook too,
    and `src/hosts/pi/test/bundle.e2e.test.ts` loads the built pi host under
    Node: both read the command with `bounded/shell-command-reader`.
- **A demo project** outside this repository, at `~/dev/bounded-demo` on the
  maintainer's machine: its `DRY-RUNS.md` records runs on both hosts; its
  `node_modules/bounded*` are symlinks into a checkout of this repository
  (they still point at the old `~/dev/bounded-core` checkout); its
  `scripts/install-bounded.ts` wraps the adapters' install helpers.

## 2. Known gaps and limits

- **Bounded discourages agents and keeps a record; it is not a security
  boundary.** An agent running as the same user can always get round it.
  For enforcement, pair it with the host's operating-system sandbox, such as
  Claude Code's sandbox mode. Known ways round it, each detailed below:
  - drift does not watch `node_modules` or `.git`;
  - commands not recognised as writing (`sed -i`, `perl -i`, `node -e`,
    `python -c`), and `git config …` or `git -c core.hooksPath=…`, seen as
    reads;
  - paths the shell guard cannot resolve (variables, globs), which it allows;
  - user-level settings outside the project (`~/.claude/settings.json`);
  - writes delayed into the background, after the call is judged;
  - drift's snapshots live in a user-writable state directory
    (`$XDG_STATE_HOME/bounded`, else `~/.local/state/bounded`).
- **The shell command reader cannot see everything** ([ADR 2026-020](adr/2026-020-shell-command-reading.md),
  "Limits"; ADR 2026-009, "Known gaps"; [slice 3](slice-3.md)): globs,
  variables and loop variables, `xargs` input, other-language code
  (`python -c`, `node -e`, `awk`, `perl -e`: reported as unresolved code),
  in-place edits (`sed -i`, `perl -i`), what a script file or program opens
  itself, and brace expansion in a command name (`{cat,.env}`). PowerShell
  (pi's `powershell` tool) is read as bash. What it cannot resolve the
  protected-paths pack allows. A copy or move whose sources are unknown records no
  write into its destination directory (`xargs cp -t dir` without a replace
  string, `cp $X dir/`), so
  nothing there is judged (ADR 2026-020, "Limits"). A command past the
  reader's bounds (1,000 ms per read on the clock, 65,536 characters,
  brace expansion past 1,000,000 characters of work, a syntax tree past
  1,000 levels, 200,000 steps of work, nesting past 64) is unread as too
  complex and refused, told to split or simplify it. The real control is
  confining commands at the operating-system level (for example a sandbox
  profile, or the host's own Bash sandbox settings, generated from
  `protectedPaths`): planned, not built.
  - **Unresolved word hides a literal one; planned: every-plausible-reading,
    as xargs now does** (ADR 2026-020, "Limits"; already so before it):
    - `sudo "$OPT" rm x`, `doas "$X" rm x`, `env "$X" rm x`,
      `nice "$N" rm x`, `nohup "$X" rm x`, `stdbuf "$X" rm x`,
      `ionice "$X" rm x`, `builtin "$X" rm x`, `command "$X" rm x`,
      `exec "$X" rm x`: read as reads of `rm` and `x`; lost: the delete of
      `x`.
    - `bash "$X" -c "rm x"`, and the same with `sh`, `zsh`, `dash` and
      `ksh`: read as nothing; lost: the code `rm x` and its delete of `x`.
    - `git $OPTS rm x`: read as reads of `rm` and `x`; lost: `git rm`'s
      delete of `x`.
    - `cp -t "$D" x`: read as a read of `x`; lost: the write into the
      directory.
    - `env -S $S rm x`: read as nothing; lost: `rm x` and its delete of `x`.
- **The prerequisites pack's limits** ([ADR 2026-019](adr/2026-019-prereqs-pack.md), [ADR 2026-025](adr/2026-025-agent-run-finish.md)):
  - `before: { write }` matches file tools' writes only; a shell command's
    writes are not matched yet, though the core now carries them in each
    execute effect's reading (item `prereqs-execute`).
  - Drift never watches `.bounded/`, so records forged by a shell command
    the protected-paths pack does not see are kept: the records rest on the protected-paths pack's
    `.bounded/**` rule.
  - Agent definitions, which say who an agent is, come from five places;
    only the project's (`.claude/agents/`, pi-subagents' project agent
    directory) can be protected. User-level `~/.claude/agents/` and pi's
    user-level agents are not covered.
  - A run whose finish never comes never counts: Claude Code 2.1.294 sends
    no SubagentStop for a run stopped at its turn limit (foreground or
    background) nor for a background run stopped with TaskStop (both
    captured). Such a run shows as pending for up to seven days.
  - Unknown, uncaptured: whether a run interrupted by the user (Esc) or
    ended by an API error fires SubagentStop. If it does, Claude Code does
    not say how it ended, so the run counts (failing open). Also unknown:
    Ctrl+B on a foreground run, a finish before its launch result, and an
    empty `agent_type`.
  - A finish can be forged by piping a SubagentStop payload to the hook from
    a shell, as anything running as the user can (see the same-user limits).
  - On pi no requirement can be met yet: pi-subagents 0.52.1 runs a call in
    the background unless it says `async: false`
    (`src/extension/config.ts:150-151`), `forceTopLevelAsync` can override
    even that (`src/runs/background/top-level-async.ts:7-14`), and a
    timed-out child may leave `isError` unset
    (`src/runs/foreground/subagent-executor.ts:3544`). So a pi delegation
    without `async: false` is refused, and no pi result is counted as
    finished, until item 1c (`prereqs-pi-async`).
  - A link is never followed: a link to a directory a rule's
    `unchangedSince` patterns could reach into, or a link whose own path
    they match, makes the rule refuse, naming the link; so does a FIFO,
    socket or device they match. Other links are ignored.
  - `before.delegate` folds case and spaces (Claude Code resolves agent
    names case-insensitively, seen on 2.1.294); `require` matches the agent
    the host resolved, exactly, so a run whose host does not say which agent
    ran never counts.
  - Records are never compacted.
  - `beforeTool` refusals are recorded with `refusedBy: null`, naming no
    pack in the Bounded log (the reason names it).
  - A requirement over patterns that match no file can never be met.
  - ABA: files edited and put back during a run compare equal, so it counts.
- **Interrupted tool calls are unchecked.** Pressing Esc in Claude Code fires
  no hook, so the change is never checked and its drift snapshot expires
  ([Claude Code adapter](adapter-claude-code.md), [drift](drift.md)).
- **Same-user limits** (the agent runs as the same OS user): a consistent
  forged snapshot wins ([drift](drift.md), [ADR 2026-011](adr/2026-011-drift.md));
  `.bounded/` (including the Bounded log), `node_modules` and `.git` are never
  watched, nor are git submodule contents ([drift](drift.md)); hard links out
  of the project are judged as inside it; check-then-use races; pi runs tool
  calls in parallel batches and offers no sequential mode
  ([Claude Code adapter](adapter-claude-code.md), [pi adapter](adapter-pi.md)).
- **The guardrails are protected only by init's seven default rules**, and
  only as written: the protected-paths pack ships none, so a project that removes them
  protects nothing.
  - They cover `bounded.config.*`, `.bounded/**`,
    `.claude/settings*.json`, `.pi/extensions/bounded/**`,
    `node_modules/bounded/**`, `.git/hooks/**` and `.git/config`. Drift
    never watches `.git`, so a git hook or config changed by a command the
    protected-paths pack does not see (`git config core.hooksPath …`) is not put back,
    and a worktree's or submodule's `.git` file points at hooks outside the
    project.
  - Not covered: the modules the configuration imports
    ([configuration](configuration.md); ADR 2026-009, "the configuration's
    imports"; protecting the import closure is planned), and the user-level
    `~/.claude/settings.json`, outside the project.
- **The Claude Code hook command must stay identical across versions.**
  Drift does not watch `node_modules`, so after an upgrade only the command
  in `.claude/settings.json`, which drift does watch, names the hook. A
  release that changed the command would leave a settings file that
  `bounded update` must rewrite, and an agent-run update
  would have that rewrite put back.
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
- **A pi shell call can wait on the reader's grammar loading.** pi prepares
  the shell command reader at session start; a call made before that
  finishes waits for it (up to 5 s), and is blocked, never let through, only
  if loading outruns pi's 3 s decision deadline. A preparation that never
  settles is cached and never retried, so every later shell call in that pi
  process waits up to 5 s for it and is blocked. Claude Code's
  first read in each hook process waits for the grammar within its 20 s
  deadline ([ADR 2026-020](adr/2026-020-shell-command-reading.md), "Reading
  in the host adapter").
- **Architecture rules guard against mistakes, not deliberate bypass**
  ([ADR 2026-013](adr/2026-013-restructure.md), rules R1 to R7). Spreading a
  genuine instance (`{ ...pack }`) is the one way past the compiler; the
  run-time parse refuses the copy
  ([ADR 2026-012](adr/2026-012-value-objects-are-classes.md)).
- **The install command's limits** (issue #65, first slice):
  - The default rule for `node_modules/bounded/**` refuses only writes the
    protected-paths pack sees: an edit, or a shell command naming the path. Drift never
    watches `node_modules` (see [drift](drift.md)), so an agent's
    `npm install` changing Bounded's installed code is not put back. Drift
    does put back what a shell command changed in `.claude/settings.json`
    and `.pi/extensions/bounded/**` (the npm end-to-end case shows it for
    the settings). An agent's `bounded update` therefore has its settings
    change undone while package.json, the lockfile and node_modules keep the
    new version. Measured: the rule adds no time to a Bash Pre and Post
    round through the bundled hook (median 318 ms with and without; mostly
    two Node starts).
  - `bounded@3.1.0` is on npm as `latest`, above the legacy
    2.x ([ADR 2026-014](adr/2026-014-legacy-harness-moves-to-legacy.md)), with
    the adapters grouped by port
    ([ADR 2026-017](adr/2026-017-adapters-by-port.md)):
    `npx bounded init` in a fresh project installs it from the registry,
    with no `--from`. 3.2.0 is on npm too, a minor release carrying a
    selection that brings in its packs' dependencies
    ([ADR 2026-018](adr/2026-018-selection-brings-in-dependencies.md)), the
    prerequisites pack, `bounded/prereqs`
    ([ADR 2026-019](adr/2026-019-prereqs-pack.md)), shell commands read in
    the core's judge with `bounded/shell-command-reader`
    ([ADR 2026-020](adr/2026-020-shell-command-reading.md)), and
    3.1.1's per-host restart notice, never published on its own. ADR
    2026-018 breaks the types 3.0.0 and 3.1.0 published
    (`Config.selectedPacks`, compose-packs' `selectedPackIds`, the meaning
    of `SelectedPacks.packs`); ADR 2026-020 makes `openProject` require a
    `shellCommandReader`, gives `pathGatePortProvisions()` two provisions,
    and removes the path gate's path-kinds and shell-parser ports and their
    adapters (its "Release"); the maintainer chose to ship these breaks in a
    minor. Not on npm yet: 3.3.0, a minor release renaming the path gate the
    protected-paths pack
    ([ADR 2026-021](adr/2026-021-protected-paths-rename.md)): it removes
    `bounded/path-gate` and `bounded/path-gate/adapters`, keeping nothing
    for them, since 3.x has no users. 3.3.0 also renames the guard log the
    Bounded log ([ADR 2026-022](adr/2026-022-bounded-log.md)), kept in
    `.bounded/log.jsonl` (an existing `.bounded/guard-log.jsonl` is left as
    it was), breaking what 3.2.0 published, with no aliases:
    `bounded/application`'s `GuardLog` and `ProjectGuardLogs` (now
    `BoundedLog` and `ProjectBoundedLogs`), `openProject`'s `guardLog`
    option (now `boundedLog`) and `bounded/adapters`' `FileSystemGuardLog`
    and `FileSystemProjectGuardLogs` (now `FileSystemBoundedLog` and
    `FileSystemProjectBoundedLogs`). 3.3.0 also corrects ADR 2026-020: the
    host adapter reads each shell command, not the core's judge, breaking
    what 3.2.0 published, with no aliases: `bounded/application`'s
    `ShellCommandReader` (now `bounded/shell-command-reader`'s),
    `openProject`'s and `OpenProjectHandler`'s `shellCommandReader` option,
    `JudgeEventHandler`'s `shellCommandReader`, `projectRoot` and
    `readWithinMs` options and its `DEFAULT_READ_WITHIN_MS` are gone;
    `ExecuteEffect.reading` is never null and `ExecuteEffectJSON.reading` is
    required; `bounded/hosts/pi`'s `translate` gives the call before its
    readings, and its `piExtension` (`ExtensionOptions`) requires a
    `readShellCommand`. Its behaviour breaks too:
    a host that sends an execute effect without a reading, as every 3.2.0
    host did, has each such call refused as an event that cannot be read and
    recorded as invalid, and a tool result's execute effects must now carry a
    reading, where 3.2.0 refused one. 3.3.0 also observes a delegated agent
    run's finish ([ADR 2026-025](adr/2026-025-agent-run-finish.md)),
    additively: `AgentRunFinished`, `onAgentRunFinish`, the
    `agent-run-finished` Bounded log kind, three optional result-entry
    fields, Claude Code's SubagentStop hook (`bounded update` installs it),
    and a method `ProjectJudge` now requires, `recordAgentRunFinish`, which
    `openProject` builds. `--from <dir>` stays only for installing a
    local tarball during development. A `--from` install overrides `bounded` in `package.json`, each package
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
  - The pack-time build mirrors `src/` in `dist/` (for example `dist/core/domain/index.js` and
    `dist/packs/protected-paths/index.js`). The workspace uses bun's hoisted
    linker: bun mis-resolved the conditionally exported package through
    several workspace symlinks.
  - In `src/cli`, installing (package manager detection, running it, the
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
- The prerequisites pack's next items (ADR 2026-019, "Future work"):
  pi-subagents' asynchronous completion (`prereqs-pi-async`, mapped to the
  agent run finish of ADR 2026-025), `before: { execute }` with shell writes
  (`prereqs-execute`, item (ii) of ADR 2026-020: matched against each
  execute effect's reading, refusing where it cannot see), and a Claude
  Code status widget listing each requirement as holds, stale or missing.
- Per-pack typed configuration, static (data) contribution lists, point
  summaries, and a provenance view of who contributed what.
- A redaction hook for the Bounded log ([Bounded log](bounded-log.md),
  [ADR 2026-022](adr/2026-022-bounded-log.md)).
- Publishing `bounded` 3.3.0 to npm (3.2.0, above the legacy
  2.x, is published,
  [ADR 2026-014](adr/2026-014-legacy-harness-moves-to-legacy.md)): the
  package is ready ([releasing](releasing.md)); the publish waits for review.
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
