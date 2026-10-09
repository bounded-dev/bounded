# The Bounded harness

A set of guardrails for coding agents, built on a small, pure core: the
mechanism by which packs (selectable bundles of behaviour) extend one another.
[docs/spec.md](docs/spec.md) is the requirement.

## The legacy harness

The original Bounded harness, which this code supersedes, is kept for
reference in the private repository `bounded-dev/bounded-legacy`, with its
own history: its decisions (ADRs `LEG-2026-NNN`) and dogfood records. This
code was developed as `bounded-core` and merged into this repository
([ADR 2026-014](docs/adr/2026-014-legacy-harness-moves-to-legacy.md)); the
original harness later moved out to its own repository
([ADR 2026-023](docs/adr/2026-023-legacy-harness-moves-out.md)).

## Status

What is missing or known to be weak is in
[docs/flight-state.md](docs/flight-state.md). Built and running on two real
hosts:

- **Slices 1 to 3.** Packs, typed extension points, contributions and
  composition ([docs/slice-1.md](docs/slice-1.md)); host-neutral events made
  of precise effects, verdicts, guards and dispatch over a composition
  ([docs/slice-2.md](docs/slice-2.md)); the protected-paths pack, the first pack
  ([docs/slice-3.md](docs/slice-3.md)). Each guide has a reading order and a
  worked example.
- **The protected-paths pack** (`bounded/protected-paths`): deny-only rules on reads,
  listings and writes, file rules, honest redirects, and protection of the
  project's own configuration ([ADR 2026-009](docs/adr/2026-009-path-gate-pack.md)).
- **The prerequisites pack** (`bounded/prereqs`, in 3.2.0): an
  action waits until a delegation to a named agent has succeeded over files
  unchanged since; only a run the host says finished counts
  ([ADR 2026-019](docs/adr/2026-019-prereqs-pack.md),
  [its README](contexts/core/src/packs/prereqs/README.md)).
- **The Bounded log**: every decision, and every refusal a host adapter
  makes itself, recorded in `.bounded/log.jsonl`
  ([docs/bounded-log.md](docs/bounded-log.md)).
- **Configuration**: `bounded.config.ts` selects packs; `openProject(root,
  { ports, shellCommandReader })` gives the judge hosts ask, and refuses
  everything when the configuration is broken
  ([docs/configuration.md](docs/configuration.md)).
- **Shell commands read once, for every pack**: the judge reads each shell
  command (the programs it runs, the files it reads, lists and writes, and
  what only the shell could resolve) and the execute effect carries that
  reading; bounded's reader is published as `bounded/shell-command-reader`
  ([ADR 2026-020](docs/adr/2026-020-shell-command-reading.md)).
- **Drift**: what a shell command changes in protected files is put back, or
  moved aside, reported and recorded; tampered snapshots are detected
  ([docs/drift.md](docs/drift.md)).
- **Host adapters**: Claude Code hooks (PreToolUse, PostToolUse,
  PostToolUseFailure; [docs/adapter-claude-code.md](docs/adapter-claude-code.md))
  and a pi extension (tool_call, tool_result;
  [docs/adapter-pi.md](docs/adapter-pi.md)), in `apps/`.

## Design in brief

- A **pack** has an id rooted at its npm package (`packIdsFor("bounded")("core")`
  is `"bounded/core"`), the packs it depends on (the pack objects
  themselves), the extension points it declares and the contributions it
  makes.
- An **extension point** is declared inside its pack, which owns it, and
  accepts values of one type: its check parses each value and may normalise it.
- A pack may contribute only to the points of packs it lists directly in
  `dependsOn`. Anything else does not compile, and is refused at composition
  if it is built from untyped data (ADRs 2026-003 and 2026-004).
- **Composition** takes the available packs and the listed packs (both as
  pack objects), selects the listed packs and every pack they depend on,
  transitively (ADR 2026-018), and
  either refuses with a message naming the pack, the extension point and the
  fix, or returns a result from which each extension point is read, typed,
  dependencies' contributions first, independent of listing order.

- **Events and guards.** A tool use is a list of effects (read, list, write,
  execute, fetch, delegate, invoke). The core pack `bounded/core` declares a
  guard point per event and effect kind; `dispatchEvent` fans a call out into
  its effects and asks each kind's guards, and the first refusal wins, naming
  the pack and the effect (ADRs 2026-005 to 2026-007).

- **Decisions are recorded.** The judge-event feature decides an event and
  records the decision through an asynchronous log (in memory, or a JSON-lines
  file); if the decision cannot be recorded in time, the action is refused
  ([docs/bounded-log.md](docs/bounded-log.md), ADR 2026-022).

- **Configuration.** A project selects its packs in `bounded.config.ts` with
  `defineConfig`; host adapters call `openProject(root, { ports:
  [...protectedPathsPortProvisions(), ...prereqsPortProvisions()],
  shellCommandReader })` and ask its judge about every event. A broken
  configuration refuses everything
  ([docs/configuration.md](docs/configuration.md), ADR 2026-010).

- **Shell commands are read by the judge.** Before any guard runs, the judge
  reads every execute effect's command through the host's
  `ShellCommandReader` and the effect carries the reading; the protected-paths pack
  judges from it, and a command that could not be read is refused. The
  reader, tree-sitter's bash grammar and the table of what commands do with
  their words live in a private context, `bounded-shell-command-reader`,
  published as `bounded/shell-command-reader`, so the core names no shell
  ([ADR 2026-020](docs/adr/2026-020-shell-command-reading.md)).

- **Drift.** What the protected-paths pack protects from writes is snapshotted before
  every allowed shell command and put back after it if it changed them, with
  a message for the agent and a record; what a command created is moved
  aside, never deleted. The core runs it through its `beforeTool` and
  `afterTool` lifecycle points; the host supplies the protected-paths pack's port
  provisions (`protectedPathsPortProvisions`, from `bounded/protected-paths/adapters`) to
  `openProject` ([docs/drift.md](docs/drift.md), ADR 2026-011,
  ADR 2026-013, ADR 2026-017).

- **The protected-paths pack** (`bounded/protected-paths`) is an ordinary pack. Packs and
  projects contribute deny-only rules to its `protectedPaths` point (a
  glob, its own exceptions, what it denies, a redirect); its guards refuse
  reads, listings and writes a rule denies, naming the rule and the pack
  that contributed it. A denial always wins. The pack ships no rules of its
  own: the configuration `bounded init` writes contributes seven defaults that
  protect the project's Bounded configuration, `.bounded/`, the files that
  run Bounded and git's hooks and config (ADR 2026-009).

The code lives in `contexts/core` (the `bounded` package), in the layered layout
described in [AGENTS.md](AGENTS.md). Decisions are in [docs/adr/](docs/adr/).

## Installing

One package, `bounded`, carries everything: the library, the protected-paths pack, the
`bounded` command and the hooks for Claude Code and pi. It runs on Node 22.18
or later (which loads `bounded.config.ts` by stripping its types), with npm,
pnpm, yarn or bun. Bun is needed only to build and publish Bounded itself.

In your project (it needs a `package.json`):

```sh
npx bounded init
```

`bounded init` adds `bounded` as a devDependency, with the project's package
manager. That is the lockfile's, else `package.json`'s `packageManager`, else
the one running npx. It then hands over to the `bounded` it installed, which
does two things.

- **It writes `bounded.config.ts`**, selecting the protected-paths pack (which brings
  in the core).
  The protected-paths pack ships no rules of its own
  ([ADR 2026-009](docs/adr/2026-009-path-gate-pack.md)). The configuration
  `init` writes contributes seven default rules. Agents may not change:
  - `bounded.config.*`;
  - Bounded's own state in `.bounded/`;
  - Claude Code's project settings files (`.claude/settings*.json`): they
    hold the hook, and `settings.local.json` could turn every hook off. The
    rest of `.claude/`, such as agents and skills, stays open to agents. Your
    user-level `~/.claude/settings.json` is outside the project and not
    covered;
  - pi's loader (`.pi/extensions/bounded/**`);
  - Bounded's installed code (`node_modules/bounded/**`);
  - git's hooks (`.git/hooks/**`), which git runs later, outside Bounded's
    view, and git's config (`.git/config`), which can point `core.hooksPath`
    at other hooks.

  Keep, change or remove them.

  **Bounded discourages agents and keeps a record; it is not a security
  boundary.** An agent running as your user can always get round it. For
  enforcement, pair it with your host's operating-system sandbox, such as
  Claude Code's sandbox mode. Known ways round it:
  - drift does not watch `node_modules` or `.git`, so what a command changes
    there is not put back;
  - commands the protected-paths pack does not recognise as writing, such as
    `sed -i`, `perl -i`, `node -e` and `python -c`;
  - `git config …` and `git -c core.hooksPath=…`, which the protected-paths pack sees
    as reads, so they get past the rules on git's hooks and config;
  - paths the protected-paths pack cannot resolve (variables, globs), which it allows;
  - user-level settings outside the project, such as
    `~/.claude/settings.json`;
  - writes delayed into the background, after the tool call is judged;
  - drift's snapshots, kept in a state directory the user (and so the
    agent) can write.
- **It installs the hooks of your agent hosts.** These are the hosts whose
  directory the project has (`.claude/`, `.pi/`), or those named with
  `--host claude-code` or `--host pi`.
  - Claude Code's hooks go into `.claude/settings.json`, running
    `node "$CLAUDE_PROJECT_DIR/node_modules/bounded/dist/hosts/claude-code/hook.js"`,
    so the file can be committed and works in every checkout.
  - pi's loader goes under `.pi/extensions/`.

Restart (or start) the hosts' sessions afterwards, as `init` says, so they
load the hooks.

The first thing to do after `init` is to add your own rules beside the
defaults, in the `contribution(protectedPathsPack.points.protectedPaths, [...])` that
`init` wrote. For example, to keep agents out of `secrets/`:

```ts
// bounded.config.ts, as init wrote it, with one rule added
import { contribution, defineConfig } from "bounded/domain";
import { protectedPathsPack } from "bounded/protected-paths";

export default defineConfig({
  packs: [protectedPathsPack],
  contributes: [
    contribution(protectedPathsPack.points.protectedPaths, [
      // ...init's seven default rules...
      { match: "secrets/**", deny: ["read", "create", "modify", "delete"], why: "secrets are kept by people", redirect: "Ask a maintainer for the value you need" },
    ]),
  ],
});
```

[Configuring a project](docs/configuration.md) describes the rule fields and
other packs.

To upgrade, run `npx bounded update`. It upgrades `bounded` to its latest
version and checks the version it installed. It then hands over to the newly
installed version, which refreshes the hooks. If the upgrade fails,
`package.json` and the lockfile are restored. `npx bounded update --no-upgrade`
refreshes the hooks from the installed version only. Neither touches
`bounded.config.ts`.

Each says, per host, whether its sessions must restart:
- Claude Code runs the hook in a new node process on every tool call, so a
  new `bounded` is live at once. Its sessions restart only when
  `.claude/settings.json` changed:
  `Restart Claude Code sessions in this project so they load the new hooks.`
  Otherwise:
  `No need to restart Claude Code sessions: bounded <version> is live on their next tool call.`
- pi loads `bounded` into its process at session start, and the CLI cannot
  know which version a running session loaded, so after every update:
  `Restart pi sessions in this project to load bounded <version>.`
- A host another package installs is told to restart after every update
  too, as it may hold `bounded` in its process.

### From a checkout (local development)

To try a build that is not published, pack it and pass the tarball's
directory with `--from`. npx is given the tarball too, while npm's `bounded`
is still the legacy 2.x
([ADR 2026-014](docs/adr/2026-014-legacy-harness-moves-to-legacy.md)):

```sh
(cd contexts/core && bun pm pack --destination /tmp/bounded)   # its prepack builds dist/
npx -p /tmp/bounded/bounded-<version>.tgz bounded init --from /tmp/bounded
npx bounded update --from /tmp/bounded                         # later, with a newer tarball there
```

With `--from`, `package.json` overrides `bounded` with the tarball, each
package manager in its own way: `$bounded` for npm and pnpm, the tarball for
bun and yarn. bun and npm are tested end to end; pnpm and yarn are not yet.
[Releasing](docs/releasing.md) describes how a release is built and
published.

## Develop

```sh
bun install
bun run check   # typecheck, lint, tests (incl. architecture and compile-time tests)
```

Changes follow [the development lifecycle](docs/development-workflow.md).
