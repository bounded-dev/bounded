# 2026-010: Issue tracking — one global skill, agent-state convention

**Status:** accepted

## Decision

Issue tracking is a single harness-procedural skill,
`skills/issue-tracking/`:

- `SKILL.md` — the flow: capture, triage, status transitions, board queries.
  It owns **all** issue/board mutations for now; the future
  development-workflow (do-work-style) port delegates to it.
- `references/template.md` — the taxonomy, single source of truth: 10
  statuses (Needs Human, Discovery, Externally Blocked, Blocked, In Review,
  In Progress, Next, Backlog, Parking Lot, Done), 3 fields (Epic, Blocked
  reason, Priority), **no managed labels**.
- `references/setup.md` — idempotent board create/reconcile, ported from the
  dotfiles `setup-project` Claude skill with all safety rules kept (snapshot
  before mutation, never delete/reorder statuses, match by exact name,
  post-change auto-remap).

Mechanism is the `gh` CLI via bash — no extension. AGENTS.md carries a
three-line pointer because description-triggering alone is unreliable.

Supporting decisions:

- **Capture ≠ triage.** Capture is title + Backlog, no assignee. Triage is
  the deliberate move out of Backlog (Epic required if the board has epics).
  Invariant: no In Progress without an assignee.
- **Ready is cut** from the old 11-status template. It was a dispatcher
  pull-state (`start-team` coordinator) and no consumer exists here. Adding
  a status later via setup is trivial and safe; deleting is dangerous — so
  lean now, resurrect if a dispatcher ever lands.
- **Agent state convention** (harness-wide, born here): `.agent-state/` is
  the per-repo, gitignored home for all temporary agent working files.
  Snapshots live at `.agent-state/issue-tracking/`. The skill self-defends
  the gitignore entry; the future project scaffolder writes it from day one.
- **Out of scope, deferred:** "no work without an issue" enforcement,
  issue-keyed worktree naming, dispatcher pull-state, extraction to a
  standalone package (ADR 2026-001 litmus) if a collaborative project ever
  depends on it.

## Why

- Every repo uses GitHub Issues + Projects, so it's global workflow —
  harness-procedural per ADR 2026-007, not a pack, not a standalone utility.
- One skill with progressive disclosure beats two skills: single trigger
  surface, taxonomy has one home, setup detail costs no context until read.
- Labels and Ready were ceremony without consumers; cutting is cheap to
  reverse, and the template only grows when a consumer exists.
- `.agent-state/` beats stashing files in `.git/` (opaque, worktree-confusing,
  nothing to do with git) and becomes the single obvious home for agent
  scratch — cheap once the harness owns project `.gitignore`s.

## Consequences

- CONTEXT.md gains the issue-tracking cluster: Board, Status, Epic, Capture,
  Triage, Agent state.
- Existing boards keep their extra statuses/labels — setup's never-delete
  rule reports them as non-standard and leaves them alone.
- The skill documents its own known gaps (no enforcement, no worktree
  policy) so deferral is explicit, not silent.
