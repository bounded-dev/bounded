# LEG-2026-038: Independent review for harness changes

**Status:** accepted; extended by LEG-2026-068 (development lifecycle)

## Decision

Every non-trivial harness change receives an independent, read-only review
before landing, using an existing scout or another contributor. The review
covers correctness, extension boundaries, documentation drift and repository
rules. The driver resolves findings, records evidence against the reviewed
diff, and obtains another pass for substantive revisions.

[The workflow](../docs/harness-workflow.md) defines the review record and a
bounded, unexecuted experiment for developing a harness component through the
developer stage. Full repository self-hosting is not claimed.

## Why

Issue #15 identifies a gap: harness changes have depended on review by their
own driving session. Independent inspection can start with the current roles
while the repository lacks a mechanical review gate.

## Consequences

This is an explicit working agreement; it neither prevents a direct push nor
replaces deterministic checks. No new agent role or socket is introduced.
The experiment must report integration work outside the developer stage and
preserve a fixed harness version during each run.
