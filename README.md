# The Bounded harness

A set of guardrails for coding agents, built on a small, pure core: the
mechanism by which packs (selectable bundles of behaviour) extend one another.
[docs/spec.md](docs/spec.md) is the requirement.

## The legacy harness

The original Bounded harness, which this code supersedes, is kept read-only
in [legacy/](legacy/README.md): not built or tested, there for its decisions
(ADRs `LEG-2026-NNN`) and dogfood records. This code was developed as
`bounded-core` and merged into this repository with both histories kept
([ADR 2026-014](docs/adr/2026-014-legacy-harness-moves-to-legacy.md)).

## Status

What is missing or known to be weak is in
[docs/flight-state.md](docs/flight-state.md). Built and running on two real
hosts:

- **Slices 1 to 3.** Packs, typed extension points, contributions and
  composition ([docs/slice-1.md](docs/slice-1.md)); host-neutral events made
  of precise effects, verdicts, guards and dispatch over a composition
  ([docs/slice-2.md](docs/slice-2.md)); the path gate, the first pack
  ([docs/slice-3.md](docs/slice-3.md)). Each guide has a reading order and a
  worked example.
- **The path gate** (`bounded/path-gate`): deny-only rules on reads,
  listings and writes, file rules, honest redirects, and protection of the
  project's own configuration ([ADR 2026-009](docs/adr/2026-009-path-gate-pack.md)).
- **The guard log**: every decision, and every refusal a host adapter
  makes itself, recorded in `.bounded/guard-log.jsonl`
  ([docs/guard-log.md](docs/guard-log.md)).
- **Configuration**: `bounded.config.ts` selects packs; `openProject(root)`
  gives the judge hosts ask, and refuses everything when the configuration
  is broken ([docs/configuration.md](docs/configuration.md)).
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
- **Composition** takes the available packs and the selected packs (both as
  pack objects), and
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
  ([docs/guard-log.md](docs/guard-log.md), ADR 2026-008).

- **Configuration.** A project selects its packs in `bounded.config.ts` with
  `defineConfig`; host adapters call `openProject(root)` and ask its judge
  about every event. A broken configuration refuses everything
  ([docs/configuration.md](docs/configuration.md), ADR 2026-010).

- **Drift.** What the path gate protects from writes is snapshotted before
  every allowed shell command and put back after it if it changed them, with
  a message for the agent and a record; what a command created is moved
  aside, never deleted. The core runs it through its `beforeTool` and
  `afterTool` lifecycle points; the host supplies the path gate's file-system
  ports to `openProject` ([docs/drift.md](docs/drift.md), ADR 2026-011,
  ADR 2026-013).

- **The path gate** (`bounded/path-gate`) is an ordinary pack. Packs and
  projects contribute deny-only rules to its `protectedPaths` point (a
  glob, its own exceptions, what it denies, a redirect); its guards refuse
  reads, listings and writes a rule denies, naming the rule and the pack
  that contributed it. A denial always wins. The pack ships no rules of its
  own: the configuration `bounded init` writes contributes five defaults that
  protect the project's Bounded configuration, `.bounded/` and the files that
  run Bounded (ADR 2026-009).

The code lives in `contexts/core` (the `bounded` package), in the layered layout
described in [AGENTS.md](AGENTS.md). Decisions are in [docs/adr/](docs/adr/).

## Installing

One package, `bounded`, carries everything: the library, the path gate, the
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

- **It writes `bounded.config.ts`**, selecting the core and the path gate.
  The path gate ships no rules of its own
  ([ADR 2026-009](docs/adr/2026-009-path-gate-pack.md)). The configuration
  `init` writes contributes five default rules: agents may not change
  `bounded.config.*`, Bounded's own state in `.bounded/`, Claude Code's settings (`.claude/settings.json`, which hold the hook), pi's loader (`.pi/extensions/bounded/**`) and Bounded's installed code (`node_modules/bounded/**`). Keep, change or
  remove them.
- **It installs the hooks of your agent hosts.** These are the hosts whose
  directory the project has (`.claude/`, `.pi/`), or those named with
  `--host claude-code` or `--host pi`.
  - Claude Code's hooks go into `.claude/settings.json`, running
    `node "$CLAUDE_PROJECT_DIR/node_modules/bounded/dist/hosts/claude-code/hook.js"`,
    so the file can be committed and works in every checkout.
  - pi's loader goes under `.pi/extensions/`.

Restart the host's session afterwards.

The first thing to do after `init` is to add your own rules beside the
defaults, in the `contribution(pathGate.points.protectedPaths, [...])` that
`init` wrote. For example, to keep agents out of `secrets/`:

```ts
// bounded.config.ts, as init wrote it, with one rule added
import { contribution, corePack, defineConfig } from "bounded/domain";
import { pathGate } from "bounded/path-gate";

export default defineConfig({
  packs: [corePack, pathGate],
  contributes: [
    contribution(pathGate.points.protectedPaths, [
      // ...init's five default rules...
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
