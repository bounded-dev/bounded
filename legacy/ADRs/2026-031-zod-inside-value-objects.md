# 2026-031: Zod is the engine inside value objects, never a public identity

**Status:** accepted

## Decision

Every value object's `static parse` is implemented over a **zod schema**;
hand-rolled structural validation (`typeof`-chains and friends) is a defect
the `zod-backed-parse` lint refuses. The schema is an implementation detail:
no zod type, schema constant, or `z.infer` may appear on any contract's
exported surface (`no-schema-on-surface`). Command and query value objects
(ADR 2026-030) compose the schemas of the domain value objects they carry.
zod is pack-pinned and pack-installed (ADR 2026-029).

## Why

This sharpens, not reverses, one-identity-per-value (ADR 2026-023). What
that rule actually bans is a second *public identity* for the same value — a
standalone schema beside a value object, each drifting from the other. A
schema *inside* the value object is the opposite: one public door
(`parse`), with a declarative, composable, battle-tested engine behind it
instead of per-run hand-rolled checks that every builder writes differently.
Run 22 banned zod outright by prompt; that was the blunt version of this
rule.

## Consequences

Validation becomes structurally identical across every component and every
run — composition of schemas mirrors composition of values, which is what
command payloads need. Lint verifies the pairing (a schema exists and
`parse` delegates to it); the generated hostile-input and round-trip law
suites carry the half lint cannot — that the schema is *right*. Existing
hand-rolled value objects (the cockpit tree) are non-conforming; migration
strategy is an open question in TN-26-004.
