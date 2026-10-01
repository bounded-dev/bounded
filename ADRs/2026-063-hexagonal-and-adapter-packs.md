# 2026-063: The hexagonal pack and the adapter packs

**Status:** accepted

## Decision

- **`ts-hexagonal`** (depends on `ts`) owns the layout of TN-26-012. It
  contributes the source roots, test suffixes, generated globs, the context
  workspace template, the `in-memory` and `console` adapter technologies,
  the shipped `docs/architecture/`, a hardened `architecture.test.ts`, the
  domain barrel, application barrel, command, handler and in-memory emitters,
  and lint rules for layers, context isolation, file roles, naming, handler
  shape, composition-root-only construction, host-only entry files and
  type-only client imports of server code.
- **Adapter and app packs** (each depends on `ts` and `ts-hexagonal`)
  contribute one adapter technology each, with its pins, emitters and app
  templates: `ts-trpc` (today's `ts-service`, renamed), `ts-mcp`,
  `ts-lambda`, `ts-web`, `ts-desktop` and `ts-drizzle-postgres`.
- **Test levels and obligations (lead decision Q2):** domain laws and one
  unit file per concept; `<feature>.test.ts` per feature; a
  `*.store.test.ts` per store per storage technology, each running the
  feature's shared conformance suite; generated in-adapter laws, which
  exercise the context-level adapter factories with fake in ports; and one
  smoke test per app against `compose<Entry>()`, run at green only. Mutation
  score stays advisory.

## Why

Each technology is a pack, so a project composes only what it uses and no
pack names another's technology outside a declared edge (TN-26-005).

## Consequences

The stub packs exist from WI-1 so every later item codes against a
registered name.

The levels reach the gates through a ts-owned socket, `testObligations`
(`agent/packs/ts/pack.ts`). The ts pack checks the domain level itself
(laws and a unit file per concept, every factory member and instance
method reached, a `<Name> — boundaries` block per value object asserted on
its `Result`); ts-hexagonal contributes the feature, store, out-adapter,
in-adapter-laws and app-smoke levels. Red checks every red-phase level;
green checks the levels only a built project can run (the app smoke test).
