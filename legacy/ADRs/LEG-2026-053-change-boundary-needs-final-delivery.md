# LEG-2026-053: A change boundary opens only after final delivery

**Status:** accepted

## Decision

`bounded change-run` and the team lead's run preparation (ADR LEG-2026-048) treat
a run as delivered only when the guard log's latest `deliver` event is a pass
of its final summary step. Any earlier `deliver` pass, a later failed or
errored delivery, or no delivery at all leaves the run undelivered, and the
boundary is refused unless `--force`d. A guard log with an unreadable or
malformed line is refused outright. One module, `agent/src/change-run-status.ts`,
decides this for both callers.

This narrows ADR LEG-2026-028, which refused a boundary only when the log held no
`deliver` pass at all.

## Why

Delivery logs a pass for each step it completes. In the
[project-local CRM dogfood run](../docs/dogfood/runs/run-26-030-project-local-crm-init.md),
an initial delivery attempt logged step passes and then stopped; the old check
would have accepted those passes as a finished run and rotated its log.

## Consequences

A run whose delivery stopped part-way must deliver again, or be abandoned with
`--force`, before a new boundary opens. File order in the guard log is
authoritative.
