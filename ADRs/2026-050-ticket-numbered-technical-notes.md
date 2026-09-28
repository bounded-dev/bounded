# 2026-050: Ticket-numbered Technical Notes in target projects

**Status:** accepted

## Decision

Target projects use a flat `docs/tn/` collection. A ticket may have one TN,
named `TN-<ticket-number>.md`, and it keeps that name as it moves from
exploration to agreed design. Its front matter names the ticket, lifecycle
status, and contract paths the ticket owns. The design gates use the active
ticket's TN and owned contracts for review, freeze, drift checks, and handoff.
A ticket publishing a design for a dependent ticket needs a frozen TN. Other
tickets need no TN unless they use the design stage. Existing projects without
the convention keep their root `spec.md` behaviour until they adopt it.

The ticket number is the tracker's issue number when the project has a
tracker. Otherwise the team lead allocates a local number (ADR 2026-048): one
more than the highest number already used in that worktree by a TN, a ticket's
run state under `.bounded/tickets/`, or the active ticket. The active ticket
is recorded per worktree in `.bounded/active-ticket`; `BOUNDED_TICKET` remains
an explicit override for direct launchers.

Nothing checks a local number against a tracker or another worktree. A local
number is unique only within its worktree. A project with a tracker always
passes the issue number. A project that adopts a tracker after using local
numbers must start its issues above the highest local number, or treat the
earlier TNs as untracked history, so a later issue never names an existing TN.

## Why

Issue state, assignment, and cross-team coordination work in the issue
tracker when there is one. The reasoning and contracts need a reviewable Git
revision. Ticket numbers give TN identity without reservations or a folder
hierarchy that follows a product structure likely to change. Local numbers
let a new project with no tracker start at once. Explicit ownership keeps
unrelated tickets' contracts out of one freeze.

## Consequences

Missing or conflicting ownership blocks the ticket design gates. A changed TN
or owned contract needs a new freeze and handoff. Superseded notes keep links
to their successors. Concurrent worktrees without a tracker can allocate the
same local number; they need numbers agreed by the user. Migrating this
harness's own year-numbered TNs and deciding whether ADRs move under `docs/`
are tracked separately.
