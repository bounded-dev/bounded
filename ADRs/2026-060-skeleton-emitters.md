# 2026-060: Skeleton emitters generate everything mechanical

**Status:** accepted

## Decision

The ts pack owns a code socket, `skeletonEmitters` (`agent/packs/ts/pack.ts`).
An `Emitter` is `{ name, description, emit(facts: ProjectFacts) → EmittedFile[] }`,
and an `EmittedFile` is `{ path, content, mode: "skeleton" | "generated" }`.
Emitters are pure: the same facts always yield the same bytes.

- `generated`: write-denied for every role (ADR 2026-058) and
  drift-checked.
- `skeleton`: written only where no file exists, then builder-owned; the
  red shadow regenerates it.

The consumers are the design gate's scaffold step, the red gate's shadow and
delivery's leftover check.

**Lead decision Q1.** `<feature>.command.ts` and every file under
`adapters/in/<tech>/` are generated from the feature contract and the
`@exposedVia` tag on its in port. The output has the same shape as the worked
example's files; only the author changes. Handler constructors take the
feature's out ports in declaration order, each parameter named after the
port's role (`store`, `exporter`). Store constructors take
`(db: <Prefix>Database)`. Both shapes are fixed by generated skeletons. The
full list of generated and skeleton files, the naming derivations and the
tag grammar are in TN-26-012.

## Why

Anything a generator can derive, a role should not write: that removes a
source of drift, and it lets the test-writer test in-adapters and handlers
at red, because their shapes are known before the builder starts.

## Consequences

The builder authors only domain `Impl` bodies, handler bodies, store and
out-adapter bodies and mappers. Composition roots were the builder's too,
until ADR 2026-066 made them generated. The in-adapter test
level is generated laws (TN-26-012).

The contract-support-file socket (`contractSupportFiles`, ADR 2026-046) is
retired with the `declare class` scaffolder and ts-trpc's shipped service
runtime: no contract on this model imports a support module, so the socket
had no consumer and no contributor left.
