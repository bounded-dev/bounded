# bounded-core

The small, pure core of the Bounded harness, a set of guardrails for coding
agents: the mechanism by which packs (selectable bundles of behaviour) extend
one another. [docs/spec.md](docs/spec.md) is the requirement.

## The legacy harness

The original Bounded harness, which this code supersedes, is kept read-only
in [legacy/](legacy/README.md): not built or tested, there for its decisions
(ADRs `LEG-2026-NNN`) and dogfood records. This code was developed as
`bounded-core` and merged into this repository with both histories kept
([ADR 2026-014](docs/adr/2026-014-legacy-harness-moves-to-legacy.md)).

## Status

Built and running on two real hosts:

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
  that contributed it. A denial always wins, and it protects the project's
  Bounded configuration itself (ADR 2026-009).

The code lives in `contexts/core` (the `bounded` package), in the layered layout
described in [AGENTS.md](AGENTS.md). Decisions are in [docs/adr/](docs/adr/).

## Develop

```sh
bun install
bun run check   # typecheck, lint, tests (incl. architecture and compile-time tests)
```

Changes follow [the development lifecycle](docs/development-workflow.md).
