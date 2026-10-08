# LEG-2026-052: Contract files reach the core through a pack socket

**Status:** accepted; its architect config write access is superseded by LEG-2026-054, and its `src/`-rooted contract globs by LEG-2026-056

## Decision

The core no longer names the filename that marks a design contract. A
data-only socket, `contractFileSuffixes` in a pack's `contrib.json`, carries
the suffixes; the TypeScript pack contributes `.contract.ts`. The core merges
the suffixes of the project's composed packs (`contractFileSuffixes` in
`agent/src/pack-contrib.ts`) and consumes them in three places:

- ticket design (`agent/src/ticket-design.ts`) accepts only suffixed paths in
  a TN's `contracts:` list;
- the architect's ownership check (`agent/src/path-policy.ts`) applies to a
  write whose path carries a composed suffix;
- the phase gate's evidence (`agent/src/path-gate.ts`) finds contract files
  in a legacy project by suffix, searching only `src/` and skipping hidden
  directories, so it names no stack's build or dependency directory. Its "no
  contract yet" refusal names the composed suffixes (or says "contract file"
  when there are none);
- the blind roles' zones: the host passes `src/**/*<suffix>` for each suffix
  as `Ctx.contractGlobs`. They become the test-writer's read exception inside
  its blind `src/` and the builder's write deny. If the composition cannot be
  read, the host passes `"unreadable"`: the test-writer gets no exception and
  the builder may not write under `src/`.

The core's architect write zone lists no contract glob either: the same
`Ctx.contractGlobs` become the architect's contract writes, and `ownerOfPath`
takes the same list. If the list is absent or unreadable, those writes are
refused. (This ADR first also gave the architect the stack's config files
through an `architectWriteFiles` field; ADR LEG-2026-054 removed that: no role
writes project config.)

With no composed pack contributing a suffix, no file is a contract. If the
composition cannot be read, a TN that lists contracts is refused, and the
architect may not write under `src/` until the composition is repaired.

## Why

The core named a TypeScript suffix and TypeScript config files in the
ticket-design regex, the path policy and the phase gate. That is a technology name in the core (TN-26-005),
and a pack for another language could not declare its own contract files.

## Consequences

Projects with ticket TNs need a readable composition before contracts can
be reviewed, frozen or written. This was already true for every gate run.
Every caller of `decide`/`ownerOfPath` that judges an architect, test-writer
or builder call, or routes ownership, must pass the contract globs. A new project's
TN README names an example contract with the composed suffix, or shows an
empty `contracts:` list when no pack contributes one.
