# LEG-2026-056: Source roots are a pack socket

**Status:** accepted

## Decision

The core no longer assumes one `src/` directory. A data field,
`sourceRoots` in a pack's `contrib.json`, lists project-relative directory
globs under which roles author code, such as `contexts/*/src` and
`apps/*/src`. Each segment is a literal name or exactly `*`, the first
segment is literal, and two roots where one could contain the other are
refused (`sourceRootsFor` in `agent/src/pack-contrib.ts`). A host passes
`sourceRootsOrUnreadable(cwd)` to the path policy.

The roots are consumed by the builder's write zone, the contract globs
(`<root>/**/*<suffix>`, replacing ADR LEG-2026-052's `src/**/*<suffix>`), the
phase gate's contract search, and ticket design's contract-path check. With
no contributor there is no write zone and no contract file. With an
unreadable composition, every write under a would-be root is refused.

Files at the project root, such as `architecture.test.ts`, are never
role-written; they are generated (ADR LEG-2026-058).

## Why

A monorepo has one source root per workspace. A core that hard-codes `src/`
names a layout, which is content, and it cannot express the hexagonal
monorepo (TN-26-012).

## Consequences

`ts-hexagonal` contributes the roots. Every core literal `src/` or `tests/`
used as policy goes (WI-2 adds a test that finds none).
