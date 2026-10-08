# Board setup / reconcile

Set up or sync a repo's Board against [the template](template.md).
**Idempotent** — safe to re-run: adds what's missing, updates descriptions,
never deletes statuses in use.

Two modes, chosen at step 2: **create** (no matching board exists) and
**sync** (reconcile an existing one).

## Safety rules (read first)

- **Never delete a status option** — issues may be attached; orphaned
  statuses are unrecoverable without a snapshot.
- **Never recreate or replace the Status field** — this destroys all option
  IDs and orphans every issue's Status.
- **Never reorder options via API** — not supported; attempting it may
  recreate options with new IDs.
- **Always take a pre-flight snapshot** before modifying any field in sync
  mode.
- **Always verify post-change** that no item lost its Status; halt and
  report if any did.
- **Match options by exact name only** — never assume positional or semantic
  equivalence between existing and template options.
- Never hardcode org names, project IDs, or field IDs — query dynamically.

## Step 0 — Snapshot location and gitignore self-defence

Snapshots live at `.agent-state/issue-tracking/snapshot-<YYYY-MM-DD-HH-MM>.json`
in the repo. `.agent-state/` must be gitignored — verify before writing:

```bash
grep -qxF '.agent-state/' .gitignore 2>/dev/null || echo '.agent-state/' >> .gitignore
mkdir -p .agent-state/issue-tracking
```

If you appended the gitignore line, tell the user.

## Step 1 — Detect repo

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
OWNER=$(echo "$REPO" | cut -d/ -f1)
REPO_NAME=$(echo "$REPO" | cut -d/ -f2)
```

## Step 2 — Find or create the board

```bash
gh project list --owner "$OWNER" --format json
```

- Board exists with title matching the repo name → **sync mode**: report what
  will change, confirm, then reconcile.
- No match → **create mode**:

```bash
gh project create --owner "$OWNER" --title "$REPO_NAME" --format json
```

Extract board number and ID.

## Step 3 — Pre-flight snapshot (sync mode only)

Before touching anything, snapshot every item's current Status:

```graphql
query {
  node(id: "<PROJECT_ID>") {
    ... on ProjectV2 {
      items(first: 100) {
        nodes {
          id
          content { ... on Issue { number title } }
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                optionId
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
        }
      }
    }
  }
}
```

**Write the snapshot to disk immediately** — before any other action — at the
path from step 0. For each item: item node ID, issue number and title, Status
name and optionId. Tell the user: "Snapshot saved to
`.agent-state/issue-tracking/snapshot-<timestamp>.json` — this is your safety
net." The file is never deleted by this skill.

## Step 4 — Reconcile the Status field

```bash
gh project field-list <NUMBER> --owner "$OWNER" --format json
```

Match by **exact name** (case-insensitive for matching, but canonical casing
from the template). For each template status:

- **Exists** → update color/description in place using the existing option
  ID. **Never change the option ID** — it links issues to their Status.
- **Missing** → add as a new option (appended; order can't be set via API).
- **Wrong order** → warn only: "Status order differs from template — reorder
  manually in Project Settings → Fields → Status." List current vs desired.
- **Extra options not in the template** → leave untouched; report:
  "Non-standard statuses found: [X, Y]. Left untouched."

## Step 5 — Post-change verification and auto-remap (sync mode only)

After any Status field change, re-query all item statuses and compare against
the snapshot.

**If any item lost its Status:**

1. Look up its previous Status name in the snapshot.
2. Find the current option ID for that name.
3. Restore via `updateProjectV2ItemFieldValue` with the current option ID.
4. Re-query to confirm.
5. Report: "Remapped N items that lost Status: [#123 Backlog, …]".

If a snapshot Status name no longer exists (e.g. renamed): set the item to
**Needs Human** and report it explicitly for manual triage.

If all items retained their Status → "✓ All item statuses verified intact".
The snapshot file stays on disk either way.

## Step 6 — Reconcile custom fields

For each template field (**Epic**, **Blocked reason**, **Priority**):

- Exists → skip ("✓ already exists").
- Missing → create.

For **Epic** on fresh creation: scan open issue titles for themes, suggest
options, and ask the user to confirm or amend before creating them.

## Step 7 — Link board to repo (if not already linked)

```bash
gh project link <NUMBER> --owner "$OWNER" --repo "$REPO"
```

## Step 8 — Board workflows (manual — instruct the user)

> **Enable two board workflows** (Board → … menu → Workflows):
>
> 1. **"Item closed"** → set Status to **Done**. For issues and pull requests.
> 2. **"Auto-archive items"** — filter `is:issue is:closed` → Archive.

## Step 9 — Migrate issues (create mode only, or on request)

Ask: "Migrate N open issues to the board?"

If yes, per issue:

1. `gh project item-add <NUMBER> --owner "$OWNER" --url <ISSUE_URL>`
2. Auto-assign Status: issues with open PRs → **In Review**; all others →
   **Backlog**.
3. Already on the board → skip.

## Step 10 — Summary report

```
Board "<Name>" — #<N>
<URL>

Statuses: <N> added, <N> updated in place, <N> non-standard left untouched
Fields:   Epic, Blocked reason, Priority — <created/already existed>
Issues:   <N> migrated / <N> already on board / <N> skipped
Warnings: <any reorder or non-standard status notes>
```

Always report what changed vs what was already correct. Running twice
produces the same result as running once.
