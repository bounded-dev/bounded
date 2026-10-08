# 2026-039: Adopt projects and review changes against a delivery baseline

**Status:** accepted

## Decision

The TypeScript pack owns project adoption, baseline capture, and design diff
commands. Adoption requires a clean tracked checkout and passing deterministic
design checks before it writes a checksum manifest and design baseline. A
successful delivery refreshes the baseline; the reviewer sees the spec,
contracts, project knowledge, and package selection changes since that point.

## Why

Existing projects need a verified entry into the developer-stage cycle, and
later changes need their earlier design context visible to an independent
reviewer.

## Consequences

Adoption creates no synthetic phase verdicts. Failed checks leave the project
without adoption state. Review freshness changes when the selected package set
changes; content edits to already reviewed design files remain part of the
current review cycle.
