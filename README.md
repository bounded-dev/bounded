# bounded-core

The small, pure core of the Bounded harness, a set of guardrails for coding
agents: the mechanism by which packs (selectable bundles of behaviour) extend
one another. [docs/spec.md](docs/spec.md) is the requirement.

**Status: slices 1 and 2** — packs, typed extension points, contributions
and composition ([docs/slice-1.md](docs/slice-1.md)); host-neutral events
made of precise effects, verdicts, guards and dispatch over a composition
([docs/slice-2.md](docs/slice-2.md)). Each guide has a reading order and a
worked example.

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
  ([docs/decision-log.md](docs/decision-log.md), ADR 2026-008).

- **Configuration.** A project selects its packs in `bounded.config.ts` with
  `defineConfig`; host adapters call `openProject(root)` and ask its judge
  about every event. A broken configuration refuses everything
  ([docs/configuration.md](docs/configuration.md), ADR 2026-010).

The code lives in `contexts/core` (the `bounded` package), in the layered layout
described in [AGENTS.md](AGENTS.md). Decisions are in [docs/adr/](docs/adr/).

## Develop

```sh
bun install
bun run check   # typecheck, lint, tests (incl. architecture and compile-time tests)
```

Changes follow [the development lifecycle](docs/development-workflow.md).
