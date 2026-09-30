# 2026-058: Generated files are a pack socket

**Status:** accepted

## Decision

A data field, `generatedFileGlobs`, lists project-relative path globs of
files that only generators write. It replaces the core's
`GENERATED_WRITE_DENY` (`tests/generated/**`). Segments are names, names
with `*`, or a whole `**`. A glob with no literal character is refused
(`generatedFileGlobsFor` and `pathGlobMatcher` in
`agent/src/pack-contrib.ts`).

A matching path is write-denied to every role, has no owner
(`ownerOfPath` → none), and is readable by every role. Every file an
emitter produces with mode `generated` (ADR 2026-060) must match a composed
glob, and a gate refuses when the tree differs from what the emitters
produce. Generated beats test-side: `*.laws.test.ts` is generated.

The exact list is in TN-26-012. Migrations now live inside the source tree,
in `contexts/<context>/src/adapters/out/drizzle/migrations/`, protected by
this socket.

## Why

Which files are generated depends on the stack, so the core cannot know it.
Before this socket, the only way to protect a generated file was to place it
outside every role's write zone, which put migrations at the project root.

## Consequences

Supersedes ADR 2026-055's rule that migrations sit outside `src/`.
