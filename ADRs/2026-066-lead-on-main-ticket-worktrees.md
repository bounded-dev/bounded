# 2026-066: The lead on main, a worktree per ticket, a board moved by gates

**Status:** accepted

## Decision

GitHub is the required tracker. Planning with `bounded init` needs nothing
from it, but applying refuses without an authenticated `gh`, a GitHub
repository and a Projects board whose Status field has exactly Backlog,
Queued, In Design, Building, Awaiting Merge and Done. `--create-statuses` sets
those options when the user agrees. Apply commits the resolved config,
including the board's id, as `.bounded/tracker.json`; issues are matched to
the board by that id. The core
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
run and leaves one pending launch for the ticket's architect. If any step
fails, it removes the worktree and branch. `merge` fetches and refuses unless `main` is
level with `origin/main`. It commits the delivered work, merges with
`--no-ff` and refuses on any conflict. It runs the packs' `projectCheckCommands`
on `main` and undoes the merge if they fail. Only then does it push without
force, close the issue and remove the worktree.

The architect is the host's own standard subagent, run in the background in
its ticket's worktree; the core never launches anything (`architect-seat.ts`).
`start` leaves one pending launch, under the lead's lock, and says how the lead
launches the architect next. The host adapter binds that launch to the
pending ticket, routes the architect's calls to the ticket worktree, and
records the seat's start and end there. `reply` leaves one pending reply,
and the adapter lets the lead continue only that architect, with exactly
that reply. Each worktree runs one architect turn at a time, which replaces
#33's project-wide one-architect lock; a seat whose host session has gone is
reported lost, never running. The cold-relaunch rule reads each recorded end.

- **Claude Code:** the lead calls the Agent tool with `subagent_type:
  "architect"`. The lead hook claims the pending launch and rewrites the call
  to exactly the brief, the model, `isolation: "worktree"` and
  `run_in_background: true`. WorktreeCreate, whose `name` carries the new
  agent's id, answers with the ticket's existing worktree and binds the agent
  to it. Every call the subagent and its workers make carries the worktree as
  its `cwd`; the project hook routes it to the worktree's own harness, which
  judges it with the worktree as the project. SubagentStop records the end;
  SendMessage, rewritten to the prepared reply, continues it. Every role
  definition runs in `dontAsk`, so only the gate's explicit allow grants a
  call that needs permission. Background tasks stay on; the hook keeps every
  worker commission in the foreground.
- **pi:** the lead calls `subagent` with `agent: "architect"`; the gate claims
  the pending launch and rewrites the call to the brief, `async: true` and the
  ticket worktree as `cwd`. pi-subagents then discovers the worktree's own
  architect definition and per-role loader, so the child pi process is bound
  by the worktree's loader and loads the worktree's extensions. The loader
  records the seat's start (releasing the pending launch) and its end;
  `subagent` `resume`, rewritten to the prepared reply, continues it.

A session opened directly in a ticket worktree is read-only.

In a ticket worktree, each gate run posts its summary as a comment on the
ticket. A refusal adds `blocked: <route>`, and that gate's next pass removes
it. Packs tag the milestone gates. Before a gate runs, it replays any pending
board update and checks that the tracker responds. If not, it refuses and
routes to the user. Any lead command refuses in the same way.

### Hardening after review

- **Merge takes only the delivered tree.** A delivered pass records the
  worktree's tree hash and its index's tree hash. `merge` refuses on any
  difference ("the worktree changed after delivery; rerun deliver") and checks
  that the committed tree is the recorded one. A `reply` to a ticket that is
  Awaiting Merge reopens it to Building and drops the record.
- **The seat fails closed.** Before a launch or a reply, the host's preflight
  checks the seat's gate (Claude Code: the project hook on PreToolUse,
  WorktreeCreate and SubagentStop, every role definition in `dontAsk` with its
  bound hook, and no managed policy switching hooks off; pi: the worktree's
  own architect loader, resolved as pi-subagents resolves it, and its project
  extension). A seat whose hook never ran cannot write, edit or run a shell
  command that changes anything. A reply that begins with `-` is refused.
- **One lead command at a time.** Every lead command holds a lock in the main
  worktree. `start` writes its record before anything else, so the ownership
  check always sees a parallel ticket. Locks and running architect turns are
  owned by a pid and that process's start time: a lock whose owner has gone,
  or whose pid was reused, is stale and is cleared.
- **Start is resumable.** Each step of `start` is skipped when it is already
  done, so running it again finishes a start that a crash interrupted.
  `status` names that command.
- **Pending board updates are replayed everywhere.** Every lead command
  replays first the main worktree's pending updates, then each ticket
  worktree's.
- **Owned paths are enforced.** In a ticket worktree the path gate confines
  every role to the ticket's owned paths (test files included only there),
  plus the ticket's own TN and the architect's scratch. Case is ignored only
  where the filesystem ignores it. A write elsewhere is refused and routed to
  the team lead.
- **Only judged tools run in a ticket seat.** On Claude Code the hook denies
  any tool it does not map and judge (MCP tools, WebFetch, Skill and the
  like), apart from a subagent's report (`SubagentHandback`) and loading a
  deferred tool (`ToolSearch`), which it judges as what they are. On pi, the
  definition's `tools:` list is the strip.
- **Locks are taken over atomically.** A stale lock is claimed by rename, and
  an owner whose liveness cannot be told is never stale.
- **A failing board update cannot block the board.** After three failures
  with the tracker answering it is quarantined; `bounded lead board
  <retry|discard>` deals with it, and pending updates are claimed by rename.

## Why

The user asked for parallel tickets in which every step is controlled by
commands and gates, run on each host's standard subagents so they use the
user's own subscription and the user can watch them. The risky part was
proved first, live, with restricted runs (Claude Code 2.1.287 and 2.1.288,
pi 0.87.1, pi-subagents 0.52.1):

- **Claude Code.** Two background architect subagents with worktree isolation
  ran at once through this checkout's real hook (`test/claude-seat-live.test.ts`,
  opt-in). WorktreeCreate bound each to its ticket's existing worktree; each
  call carried that worktree as its `cwd` and was judged there (its guard log,
  not the main worktree's); a write outside was refused; SubagentStop recorded
  each end; SendMessage resumed a stopped one in its worktree. The subagent's
  own definition hooks load only in a trusted project, and a worktree is
  trusted with its repository; in an untrusted folder every call that needs
  permission is refused.
- **pi.** From a headless lead, two async architect children with ticket
  directories as `cwd` started together, each discovered its directory's own
  architect definition and loader (resolved from the definition's directory),
  had its writes inside allowed and outside refused, and recorded its start
  and end with the run id the lead sees. `resume` of a finished run started a
  new run in the same directory with a new run id, which the loader recorded.
- **Not shown without a TUI.** Claude Code's agent view lists sessions, not
  subagents, so the user talks to an architect through the lead. pi's fleet
  view, which lets the user open and steer a running child, is a dogfood
  entry.

## Consequences

- A ticket's work is committed only by `merge`. The architect still cannot
  run a mutating git command.
- Each worktree installs its own dependencies, so `start` costs one lockfile
  install.
- On Claude Code the gate's explicit allow is the only permission a ticket
  seat has. Claude Code still lets a seat without its hook read files and run
  shell commands it classifies as read-only; such a seat can change nothing.
- Launching, binding and routing live in the host adapters behind one seam
  (`ArchitectHost`); the core keeps only the pending launch, the pending reply
  and the seat's recorded life.
- Background tasks stay on in a project installation; a setting that turns
  them off is refused, since it would serialize the architects.
- Projects initialized before this decision lack the tracker config. They need
  a re-init before the lead's commands run.
- An end-to-end run of a real ticket on each host is a dogfood entry. This ADR
  does not claim one.
