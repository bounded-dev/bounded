# bounded-core

The small, pure core of the Bounded harness, a set of guardrails for coding
agents: the mechanism by which packs (selectable bundles of behaviour) extend
one another. [docs/spec.md](docs/spec.md) is the requirement.

**Status: slice 1** — packs, typed extension points, contributions and
composition. Start with [docs/slice-1.md](docs/slice-1.md) for a reading order
and a worked example.

## Design in brief

- A **pack** has a name, the packs it depends on, the extension points it
  declares and the contributions it makes.
- An **extension point** is declared by one pack, its owner, and accepts
  values of one type, optionally checking each.
- A pack may contribute only to its own extension points or those of a pack it
  depends on. Anything else does not compile, and is refused at composition
  if it is built from untyped data.
- **Composition** takes the available packs and a project's selection, and
  either refuses with a message naming the pack, the extension point and the
  fix, or returns a result from which each extension point is read, typed,
  dependencies' contributions first, independent of listing order.

The code lives in `contexts/core` (`@bounded/core`), in the layered layout
described in [AGENTS.md](AGENTS.md). Decisions are in [docs/adr/](docs/adr/).

## Develop

```sh
bun install
bun run check   # typecheck, lint, tests (incl. architecture and compile-time tests)
```

Changes follow [the development lifecycle](docs/development-workflow.md).
