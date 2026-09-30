# 2026-059: The contract owns the name

**Status:** accepted

## Decision

Replaces the `declare class` contract model of ADRs 2026-015, 2026-023 and
2026-026. It follows the worked example's `domain.md`:

- A domain contract is `interface <Name>` (with `readonly __brand:
  "<Name>"`) plus `interface <Name>Factory`. `parse(raw: unknown)` returns
  `Result<<Name>>`; an identifier's factory adds `generate()`; an entity's
  factory declares `new (...)`.
- The implementation file holds an unexported `<Name>Impl implements
  Contract.<Name>` and ends with exactly
  `export type <Name> = Contract.<Name>;` and
  `export const <Name>: Contract.<Name>Factory = <Name>Impl;`, importing
  the contract as `import type * as Contract`. The builder writes only the
  class body.
- Domain contracts import only other contracts and the shared `Result`.
- Application contracts (`Input`, `Command` + `CommandFactory`, the in
  port, per-feature out ports) may `import type` from the generated domain
  barrel `@<scope>/<context>/domain` (lead decision Q3; the barrel is
  generated, so the import cannot reach an implementation's body).
- Laws are colocated as `<concept>.laws.test.ts`.

ADR 2026-031 stands: `parse` is implemented over zod inside `<Name>Impl`.

## Why

The example's form gives each concept one name used as both type and value,
lets the compiler check the static side through the factory annotation, and
keeps contracts pure interfaces. The `declare class` form needed three ADRs
of rules to reach the same guarantees.

## Consequences

Contract lint rules that assume `declare class` are rewritten (WI-3). ADRs
2026-015, 2026-023 and 2026-026 are superseded.
