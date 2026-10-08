# 2026-024: The architect has a scratch zone

**Status:** accepted

## Decision

A top-level `scratch/**` directory is writable by the architect alone (not the
three blind roles), gitignored in delivered repos, and invisible to every gate
that globs the project: contract-purity and surface-check are `src/`-scoped, and
`scratch` joins the shared `IGNORE_DIRS` that the checksum/freeze set, the
scaffolder's contract discovery, and its orphan sync all walk through. A
`scratch/*.contract.ts` therefore gets no skeleton, no manifest entry, no
surface pair; a broken probe there cannot block a gate typecheck, and `deliver`
(which walks only `src/` and `tests/`) never ships it. A diagnostic in scratch
routes to the architect, never another role.

## Why

Three consecutive runs, three different models, each tried to write a throwaway
type-probe (`scratch-nominal-check.ts`, `src/__probe/probe.ts`,
`src/scratch-probe/…`) to test a type idea, and each was refused because the
architect's only writable surface was the spec and the contracts. One then
smuggled the probe in as a real contract, polluting the deliverable, and spent
~10 minutes on cleanup. The want is legitimate — deciding a nominal shape or a
union is real design work and the type checker is the only honest oracle for it
— so it gets a sanctioned home rather than a refusal that the model routes
around at a higher cost than allowing it.

## Consequences

The architect experiments in `scratch/` and the deliverable stays clean by
construction. Because the exclusion lives in the shared `IGNORE_DIRS` and the
existing `src/`-scoping, no gate needed a special case for it. The blind roles
cannot write scratch, so it is never a side channel between them.
