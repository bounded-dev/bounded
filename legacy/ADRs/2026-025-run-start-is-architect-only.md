# 2026-025: The run-start marker is the architect's, by role not by process

**Status:** accepted

## Decision

The `run-start` guard event — the marker the timing clock starts from — is
stamped only by the driving (architect) session, decided by the bound role
(`isDrivingRole`), not by any process-level signal. Worker sessions
(test-writer, builder, reviewer) stamp nothing. For guard logs written before
this rule, phase-durations resolves the clock to the last architect-role
run-start before the first phase marker, falling back to the earliest run-start
only when no marker carries the architect role.

## Why

Run 16 logged 14–19 run-start markers per arm, because every subagent session
stamped one at its first gated tool call, and the timing clock picked a late one
(a reviewer's), skewing the reported DESIGN phase to nonsense. The obvious fix —
"stamp only in the root session" — does not work: pi-subagents sets
`PI_SUBAGENT_CHILD=1` on every spawned child, and the architect is itself
spawned (its parent is the orchestrator; the workers' parent is the architect),
so that env var cannot tell the driver from its workers. The signal that does
separate them is the one the gate already holds — the bound role — which is
exactly the question the marker means to ask: whose first call started the run.

## Consequences

One marker per run, on the session whose clock the timing block reports. The
per-session-logging alternative (keep stamping everywhere, resolve at read time)
is retained only as the backward-compatible fallback for already-archived logs;
new runs carry a single architect marker.
