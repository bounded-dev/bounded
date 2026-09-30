# 2026-061: Workspaces are generated from the design

**Status:** accepted

## Decision

- **Contexts** come from contract paths: every workspace containing a source
  root with a contract file.
- **Apps** come from a TN front-matter `workspaces:` map from a workspace
  directory to a template kind (`apps/web: web`). The core validates only
  the shape (TN-26-012); packs interpret it.
- Two ts-owned data sockets describe what can be generated
  (`agent/packs/ts/pack.ts`): `workspaceTemplates` (per kind: the directory
  it sits in, a manifest template, and seed files with their modes), and
  `adapterTechnologies` (id, direction, in-adapter feature role or
  out-adapter storage flag, exact pins). Both are strict: unknown fields,
  duplicates across the composition, range pins and missing template files
  are refused.
- The project package generator writes the root manifest and every
  workspace manifest. Each workspace manifest's `exports` has one entry per
  layer and one per adapter technology folder present. Its `workspace:*`
  dependencies come from composition-root imports.
- Nested manifests become generated config (ADR 2026-054), not drift. A
  `node_modules` directly under a workspace root is expected; one anywhere
  else is refused.

## Why

The worked example is a monorepo with one package per context and app. Hand-
written manifests would be a role writing config, which ADR 2026-054 forbids.

## Consequences

Adding an app is a design decision recorded in a TN, not a file edit.
