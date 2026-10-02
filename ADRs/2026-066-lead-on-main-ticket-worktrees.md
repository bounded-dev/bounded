# 2026-066: The lead on main, a worktree per ticket, a board moved by gates

**Status:** accepted

## Decision

GitHub is the required tracker. `bounded init` refuses without an
authenticated `gh`, a GitHub repository and a Projects board whose Status
field has exactly Backlog, Queued, In Design, Building, Awaiting Merge and
Done. It commits the resolved config as `.bounded/tracker.json`. The core
holds a tracker port (`src/tracker.ts`), the adapter lives in `trackers/`,
and no role can reach the tracker.

The team lead stays in the main worktree on `main`. It is read-only apart from
its commands, and every host parses them with one parser (`lead-commands.ts`):

| Status | Set by |
|---|---|
| Backlog | `bounded lead ticket create` (fixed sections: outcome, acceptance criteria, owned paths, dependencies, decisions to return) |
| Queued | `bounded lead queue` (an unreleased dependency becomes `waiting on #n`) |
| In Design | `bounded lead start` |
| Building | a design-frozen gate pass |
| Awaiting Merge | a delivered gate pass |
| Done | `bounded lead merge` |

`start` runs only for an open, Queued ticket that is waiting on nothing. It
refuses when the ticket owns a contract path that overlaps one owned by
another started ticket. Otherwise it creates the ticket's worktree and branch
(`.bounded/worktrees/<n>`, `ticket/<n>`), installs dependencies, prepares the
run and launches the architect in that worktree. If any step fails, it
removes the worktree and branch. `merge` fetches and refuses unless `main` is
level with `origin/main`. It commits the delivered work, merges with
`--no-ff` and refuses on any conflict. It runs the packs' `projectCheckCommands`
on `main` and undoes the merge if they fail. Only then does it push without
force, close the issue and remove the worktree.

The architect is the ticket worktree's own top-level host session, launched
by a host-neutral wrapper (`architect-launch.ts`). Each turn is one run of
the host's command line. `status` shows the turn's report, and `reply`
continues the same session. Each worktree runs one architect turn at a time,
which replaces #33's project-wide one-architect lock. The wrapper records the
end of every turn in the worktree's guard log, where the cold-relaunch rule
reads it. On Claude Code, the seat reaches the worktree's own settings hook
through the session's environment. The hook accepts it only in a worktree
that `start` marked. On pi, the architect's loader is passed with `-e`, and
the project's extensions are trusted with `--approve`. Any other top-level
session in a ticket worktree is read-only. The lead may no longer commission
an architect as a subagent.

In a ticket worktree, each gate run posts its summary as a comment on the
ticket. A refusal adds `blocked: <route>`, and that gate's next pass removes
it. Packs tag the milestone gates. Before a gate runs, it replays any pending
board update and checks that the tracker responds. If not, it refuses and
routes to the user. Any lead command refuses in the same way.

## Why

The user asked for parallel tickets in which every step is controlled by
commands and gates. That required the risky part to be proved first, on both
hosts, on 2026-10-02 (Claude Code 2.1.287, pi 0.87.1) with restricted
headless runs:

- **Claude Code in-session isolation was rejected.** An Agent call with
  `isolation: worktree` does move the subagent's `cwd`, and nested workers
  inherit it. However, hooks still resolve to the lead's `CLAUDE_PROJECT_DIR`
  and harness. A `WorktreeCreate` hook receives only a generated name, so it
  cannot be tied to a ticket. With background tasks disabled, the lead blocks
  until every architect finishes.
- **A launched session works.** A `claude -p` in a git worktree used that
  worktree's settings hook, `CLAUDE_PROJECT_DIR` and `cwd`. The launcher's
  environment reached the hook. Frontmatter hooks fired, because the
  worktree inherits the trust of its repository.
- **A launched pi session works.** `pi -p --approve -e <loader>` in a
  worktree loaded both the worktree's project extension and the role loader,
  and both judged calls with the worktree's `cwd`. Nesting worktrees under
  the main checkout keeps pi's ancestor-based trust for the architect's own
  child workers.

A launched session also lets tickets run in parallel while the lead keeps
talking to the user.

## Consequences

- A ticket's work is committed only by `merge`. The architect still cannot
  run a mutating git command.
- Each worktree installs its own dependencies, so `start` costs one lockfile
  install.
- A headless turn cannot answer a permission prompt. The Claude Code launch
  therefore accepts edits and allows the architect's own tools, and the hook,
  which runs before any permission rule, remains the gate.
- The architect talks to the user only through the lead's `status` and
  `reply`.
- Projects initialized before this decision lack the tracker config. They need
  a re-init before the lead's commands run.
- An end-to-end run of a real ticket on each host is a dogfood entry. This ADR
  does not claim one.
