# 2026-071: A later ticket takes a delivered ticket's contract

**Status:** accepted

## Decision

A later ticket that must change a contract owned by an earlier, delivered
ticket **takes** it in its own TN front matter:

```yaml
contracts:
  - contexts/money/src/domain/currencies/currency.contract.ts
takes:
  - contexts/money/src/domain/currencies/currency.contract.ts from TN-1
```

`takes:` is one line with nothing after the colon. Each entry is
`  - <path> from TN-<n>`, and the block ends at the first unindented line. The
path must also be listed under `contracts:`, so `contracts:` stays the one
freeze surface (2026-050). A bare `takes:` is no takes, and a path may appear
only once. Any other shape is refused on the active note. On another ticket's
note it refuses ownership checks with the usual repair message, or, where only
the active ticket's own design is read, releases nothing.

**Ownership is resolved from the TN files alone.** For each contract, the
claimants are the notes that list it. A claimant is *released* when another
claimant takes the contract from it. Exactly one unreleased claimant must
remain, or the gates refuse: two owners keep today's "both own" refusal, now
with a hint naming `takes:`, and a contract taken back and forth has no owner
("no ticket owns <path>: <a> and <b> take it from each other"). Chains work: a
third ticket takes from the current owner. A take must cite a note that exists,
is not the active ticket's, has status `active` or `ratified`, lists the
contract, belongs to no abandoned ticket, and has not already given the
contract to another ticket.

**The giving ticket's record is never rewritten.** Its TN and its
`.bounded/tickets/<n>/` manifest and snapshot stay as delivered. Its
*effective* contracts are those it lists minus those taken from it, and
`TicketDesign.contracts` carries that set, so every consumer of the design
(freeze, review, change baseline and diff, handoff, red gate, phase gate) sees
the taker as the owner without change. The release applies whether or not the
reader checks other notes, so the phase gate's design hashes match the freeze.
The path gate tells the giver "contract '<p>' is not owned by ticket #<n>:
<TN> took it", and the taker still may not write the giver's TN.

**A first freeze that takes a delivered contract stands over worker-owned
drift.** `TicketDesign.taken` lists the active ticket's takes. When it is
non-empty, the design gate's typecheck step treats a first freeze as it treats
a re-freeze (2026-028): diagnostics owned entirely by the workers are printed,
attributed and let through, and the composite event records `typecheckDrift`
and `takes`. Diagnostics in contracts, config, generated files or untouched
skeletons still block, and `green_gate` still requires a clean compile. Every
other first freeze keeps the full block.

**An abandoned ticket cannot be taken from.** `bounded change-run --force`
writes `.bounded/tickets/<n>/abandoned` (JSON: the archived log's file name and
the time) for the ticket the abandoned log names: the latest event whose
`detail.ticket` is a ticket number. A log that names no ticket marks none; the
script never falls back to the selected ticket, which may be the next one. A
delivered boundary removes the delivered ticket's marker before capturing the
baseline. A note whose ticket carries the marker is not a claimant at all: it
neither claims nor releases, so an abandoned take cannot orphan the giver's
contract. A superseded note is skipped as before, so its takes lapse and the
contract returns to its giver; a successor that needs it takes it from that
owner.

## Why

The 2026-10-03 dogfood run (issue #49): ticket #2 needed to change a contract
owned by delivered ticket #1. The ownership gate refused eight writes ("TN-2
and TN-1 both own …"), and editing TN-1 was refused because only ticket #2's TN
may be written. The rule the change carried was specified but never enforced.

Resolving ownership from the notes keeps it deterministic, readable with no run
state beyond the abandonment marker, and identical in every worktree. The gate
checks that the cited note is an agreed note of another ticket that lists the
contract. That the ticket was *delivered* is guaranteed by the lead's
lifecycle, not by the gate: a worktree runs one ticket at a time and switches
only after final delivery (2026-048, 2026-053). The architect cannot fabricate
the cited note, because it may write only its own TN.

Drift is tolerated only on a take because a take, by design, changes a contract
that earlier workers' code implements, so the drift is the change, as in
2026-028. Without a take, a first freeze's worker-owned diagnostics have no
such cause and keep blocking. There is no bypass: the architect cannot write
worker zones or other tickets' notes, and green still requires a clean compile.
The marker is positive run state that refuses only when present, so its absence
(a fresh clone) refuses nothing.

## Consequences

Chains are allowed; a return to an earlier owner is not. Handoff receipts from
the giver go stale once the taker changes the contract, which is correct. The
giver's next change run sees a removed file and needs a fresh review, which a
change run needs anyway. ADR 2026-066's overlap check on `start`, once merged,
must honour takes. Planned strengthening: once 2026-066 lands, a project with
its committed tracker config `.bounded/tracker.json` will also require the
cited note committed at `HEAD` and listing the contract. Showing the taken
contract's diff against the giver's delivered snapshot is left to a follow-up.
