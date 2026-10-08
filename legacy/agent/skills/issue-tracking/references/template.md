# Board template

The canonical taxonomy every board is set up against. Single source of truth —
`SKILL.md` (flow) and `setup.md` (setup/reconcile) both defer to this file.

## Statuses (in column order)

Order matters: the GitHub API **cannot reorder** status options, so column
order is only correct when the board is created. On reconcile, wrong order is
reported, never fixed via API.

| # | Status | Color | Description |
|---|--------|-------|-------------|
| 1 | Needs Human | RED | Waiting on the user — open the issue, make a decision |
| 2 | Discovery | PINK | Needs design thinking — open questions, unresolved scope |
| 3 | Externally Blocked | ORANGE | Waiting on a third party or external dependency |
| 4 | Blocked | ORANGE | Waiting on another issue — resolves when that issue does |
| 5 | In Review | PURPLE | PR open or change under review |
| 6 | In Progress | YELLOW | Actively being worked on — must have an assignee |
| 7 | Next | BLUE | Shortlisted and startable — the queue above Backlog |
| 8 | Backlog | GRAY | Known work, not prioritised yet — capture lands here |
| 9 | Parking Lot | GRAY | Deferred indefinitely — revisit only if conditions change |
| 10 | Done | GREEN | Merged/closed |

## Custom fields

- **Epic** (SINGLE_SELECT) — groups issues by theme. Options are per-board,
  suggested from issue themes at setup and grown by triage.
- **Blocked reason** (TEXT) — short reason shown on the card when Status is
  Needs Human, Blocked, or Externally Blocked.
- **Priority** (SINGLE_SELECT) — High / Low. Blank means medium.

## Labels

None managed. Setup never creates, updates, or audits labels; repos keep
whatever GitHub seeded. If managed labels are ever wanted, add them here and
re-run setup — adding is safe, deleting is not.

## Defaults and invariants

- **Capture**: title + Status Backlog. No assignee, no Epic, no Priority.
- **Triage**: decides Status, Epic (required if the board has Epic options),
  Priority (only when stated).
- **Invariant**: no issue may be In Progress without an assignee.
