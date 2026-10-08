# 2026-018: Every guard is told to the role it binds — drift-tested

**Status:** accepted

## Decision

The deterministic-check principle runs both ways. Forward: every rule that
must hold is a mechanism (established practice). Backward: every rule a
mechanism enforces on a role must be named in that role's brief, so the agent
can get it right the first time instead of learning the rule from a block.
The relationship is itself enforced: gates export their rule-id lists and
`guard-doc-drift.test.ts` fails the build if an enforced rule is not named in
the brief of the role it binds.

## Why

A guard the agent has never heard of is a bounce tax paid on every run. And
briefs maintained by hand drift exactly like every other duplicate — so the
index (briefs) is tested against the body (gates). This is also the shape
that scales with guidance volume (docs/VISION.md): prose compliance decays as
the rulebook grows because it competes for attention; enforcement holds flat;
the brief stays a bounded index however large the body gets.
