---
name: issue-tracking
description: GitHub Issues + board (Projects v2) workflow — capture issues, triage, status transitions, board queries, and board setup/reconciliation. Use whenever the user mentions creating an issue or ticket, asking what's on the board, moving work between statuses, or setting up project management for a repo.
---

# Issue tracking

All work is tracked in GitHub Issues plus one **Board** (GitHub Projects v2)
per repo, named after the repo. Terms — Board, Status, Epic, Capture, Triage,
Agent state — are defined in the harness `CONTEXT.md`.

The taxonomy (statuses, fields, defaults) lives in
[references/template.md](references/template.md) — read it before creating or
transitioning issues. Board setup/reconciliation lives in
[references/setup.md](references/setup.md) — read it when no board exists or
the user asks to set up, initialise, or sync the board.

Mechanism is the `gh` CLI. Verify `gh auth status` first; if unauthenticated,
stop and tell the user.

## Rules

- **Never hardcode** org names, project IDs, field IDs, or option IDs —
  always query dynamically.
- **Status names must match the template exactly** (case-sensitive in the
  API). Read `references/template.md` for the canonical list.
- **No In Progress without an assignee.** Capture leaves the assignee blank;
  starting work assigns someone (default: current user, `@me`).
- **Worktree/branch policy is out of scope** for this skill — it belongs to
  the development workflow, not issue tracking.
- Temporary working files (snapshots, scratch) go in `.agent-state/` —
  gitignored, never committed. Verify the `.gitignore` entry before writing;
  append `.agent-state/` if missing and tell the user.

## Prelude — resolve repo, owner, board

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
OWNER=$(echo "$REPO" | cut -d/ -f1)
REPO_NAME=$(echo "$REPO" | cut -d/ -f2)

# The board is named after the repo
BOARD_NUM=$(gh project list --owner "$OWNER" --format json \
  --jq '.projects[] | select(.title == "'"$REPO_NAME"'") | .number')
```

If `BOARD_NUM` is empty → no board. Offer to run setup
(`references/setup.md`). Do not improvise one.

## Core procedure — set an issue's Status

Every transition uses this. `<STATUS_NAME>` must exactly match a template
status.

```bash
ISSUE_NUM=<N>
STATUS_NAME="<exact template status>"

ITEM_ID=$(gh issue view "$ISSUE_NUM" --json projectItems \
  --jq '.projectItems[0].id')
PROJECT_ID=$(gh project view "$BOARD_NUM" --owner "$OWNER" --format json --jq '.id')

read FIELD_ID OPTION_ID <<< "$(gh project field-list "$BOARD_NUM" --owner "$OWNER" --format json --jq '
  .fields[] | select(.name == "Status") | .id as $f
  | .options[] | select(.name == "'"$STATUS_NAME"'") | "\($f) \(.id)"')"

gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
  --field-id "$FIELD_ID" --single-select-option-id "$OPTION_ID"
```

If `ITEM_ID` is empty, the issue isn't on the board — add it first:

```bash
gh project item-add "$BOARD_NUM" --owner "$OWNER" \
  --url "$(gh issue view "$ISSUE_NUM" --json url -q .url)"
```

## Capture

"Create an issue for X" — fast, no interrogation.

1. `gh issue create --title "..." --body "..."` — **no assignee**.
2. Add to board (`item-add` above).
3. Set Status → **Backlog** (core procedure).

That's it. No Epic, no Priority, no label decisions at capture — that's what
triage is for. If the intent is clearly "this is in flight now", capture then
immediately run the start-work transition instead.

## Triage

The deliberate act of moving issues out of Backlog. Per issue:

- Set **Status** (core procedure).
- Set **Epic** if the board has Epic options defined — same procedure with
  field name `Epic`. List options first; ask the user only when ambiguous:
  ```bash
  gh project field-list "$BOARD_NUM" --owner "$OWNER" --format json \
    --jq '.fields[] | select(.name == "Epic") | .options[].name'
  ```
- Set **Priority** (High / Low; blank = medium) only when stated.

## Transitions

| Moment | Action |
| --- | --- |
| Start work | Assign if blank (`gh issue edit N --add-assignee @me`), then Status → **In Progress**. Never In Progress unassigned. |
| PR opened / under review | Status → **In Review** |
| Waiting on user decision | Status → **Needs Human**; set **Blocked reason** (text field) to what's needed |
| Waiting on another issue | Status → **Blocked** + Blocked reason naming the issue |
| Waiting on a third party | Status → **Externally Blocked** + Blocked reason naming the dependency |
| Needs design thinking | Status → **Discovery** (pair with the expand / grill-me flow) |
| Merged / closed | The board's "item closed" workflow sets **Done** automatically. Verify; set manually only if missing. |
| Deferred indefinitely | Status → **Parking Lot** |

Blocked reason is a text field:

```bash
REASON_FIELD=$(gh project field-list "$BOARD_NUM" --owner "$OWNER" --format json \
  --jq '.fields[] | select(.name == "Blocked reason") | .id')
gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
  --field-id "$REASON_FIELD" --text "<short reason>"
```

When a block clears, restore the previous working Status and clear the reason
(`--text ""`).

## Board queries

```bash
# Everything on the board
gh project item-list "$BOARD_NUM" --owner "$OWNER" --format json

# Open issues not yet on the board
gh issue list --json number,title,projectItems \
  --jq '.[] | select(.projectItems | length == 0) | "\(.number)\t\(.title)"'

# One issue's state
gh issue view "$ISSUE_NUM" --json number,title,state,assignees,projectItems
```

## Known gaps (deferred to the workflow port)

- Nothing enforces "no work without an issue" yet — that belongs to the
  kick-off stage of the future development-workflow skill.
- Worktree/branch naming conventions likewise.
