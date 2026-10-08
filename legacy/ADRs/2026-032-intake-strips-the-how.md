# 2026-032: Intake strips the how — every spec is reworked to "what is required"

**Status:** accepted

## Decision

A **general rule of the developer stage, for all work** — not confined to
API services or any stack: every spec entering the stage, whether from a
user or a parent agent, is reworked at intake into pure requirement language
— *what* must be possible, for *whom*, under *what* rules — and any embedded
implementation choice ("over GraphQL", "as a cron job", "using library X",
"add a column") is stripped before design begins. The architect's spec
records what was stripped in an "Intake" section, so the removal is a
visible act, never a silent one.

Two outcomes: an incidental "how" simply vanishes and harness policy (ADR
2026-029 for stacks, the packs' conventions generally) supplies the
implementation; a "how" that is a genuine constraint — an existing system to
integrate with, a contractual format — is a product decision and routes to
the user (TN-26-001 dispute protocol), never silently obeyed or dropped.

## Why

Tickets are written by people (and agents) thinking in solutions; recorded
policy is how this harness keeps a hundred runs consistent. If ticket
phrasing can bind implementation, any author overrules policy by wording,
and the same requirement lands differently depending on who typed it. The
design authority is the architect operating under harness policy; the
ticket's authority is the requirement.

## Consequences

Specs become comparable across runs and sources. The reviewer reads the
Intake section and can challenge a stripping (or a missed one). Not
mechanically gateable — semantics — so it is skill + brief guidance with the
reviewer as the check; where a stripped "how" names a technology, the
dependency allowlist and `blessed-stacks-only` lint (ADR 2026-029) backstop
the leak mechanically. ADR 2026-029 narrows to what it is really about:
binding capabilities to blessed stacks.
