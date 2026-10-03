# 2026-067: Composition roots are generated, their dependencies grouped by area

**Status:** accepted

## Decision

Every app's `composition-root.ts` is a generated file (ADR 2026-058,
2026-060). No role writes it. Each app pack emits its own through one
ts-hexagonal function (`packs/ts-hexagonal/scripts/composition-root.ts`).
The app pack supplies the features it hosts, the in-adapter factory, the
function names and its imports. The function builds the rest:

- **Per feature,** `new <InPort>Handler(…)` with its out ports in
  declaration order:
  - a store port gets the store of the project's storage technology. A
    technology that declares `connect` wins. With none composed, the one
    whose database is a value built with no arguments (the in-memory store)
    is used. Two of either kind are refused.
  - any other out port gets the adapter of the first technology its
    `@implementedBy` tag names.
- **Infrastructure is created once per compose function:** one connected
  database, or one `new <Prefix>Database()` per context.
- **`connect`** is a new, optional field on a storage technology in
  `adapterTechnologies` (TN-26-012 §10). It holds the environment variable
  and, per app runtime, the function and module that connect (`drizzle`
  from `drizzle-orm/bun-sql` on Bun, `drizzle-orm/node-postgres` on Node).
  The module's package must be in that runtime's `appPins`. The URL is read
  through one fixed helper, `connectionUrl()`, that refuses an unset value
  and never falls back. `env` must be a plain upper-case identifier.
- **The names stay** `composeApp()` and `compose<Entry>()`, so entry files and
  app smoke tests are unchanged. The smoke test is still owed. An export of a
  generated module that constructs authored classes (`composeApp`) counts as
  reaching them, so the test lint does not refuse the smoke test as a test
  of generated code. Its other exports, and the generated router, do not.
- **Dependencies are grouped by area,** the generated router's namespaces:
  `createNetWorthRouter({ members: { add, list, rename }, … })`. The key is
  `camel(area)`, then the feature's `routeKey` (`dependencyGroups` in
  `naming.ts`). The tRPC context router, the MCP server and each Lambda
  factory take this shape. The area routers take the inner object.
- **Globs:** each app pack adds its composition root to `generatedFileGlobs`.
  The file is write-denied to every role and checked for drift.

## Why

In the 2026-10-03 dogfood the builder wrote every composition root from a
skeleton, and every line of it was mechanical. The lint rules confine
construction to the composition root, but nothing kept branching or helpers
out of it. Generating the file removes that source of drift.

The grouped shape **departs from the worked example on purpose**, at the
user's request. The example passes one flat list of every feature
(`createNote`, `listNotes`, …) to every adapter. Grouped dependencies read
the way the API is called (`members.add`), keep a large context's
composition legible, and are the same shape in every adapter.

## Consequences

- The builder no longer writes composition roots. A wrong one means the
  contract or the composition is wrong.
- The harness's reference copy of the example
  (`packs/example-suite/reference/example`) carries the grouped routers, MCP
  server, Lambda factory and generated composition roots.
- The manifest generator now also reads a tag in a one-line doc block
  (`/** @implementedBy console */`), as the example writes it. Without that,
  the generated Lambda composition root imported an adapter its context
  manifest did not export.
