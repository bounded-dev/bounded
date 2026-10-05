# 2026-073: Long gates run as detached, resumable jobs; a RUNNING verdict

**Status:** accepted

## Decision

No gate depends on finishing inside one host call. A gate step that can
outlast a host's command limit (Claude Code kills a Bash call after ten
minutes at most) runs as a **background job** that a later call collects.

**The mechanism is core; packs opt in by one field.** A registry entry
(ADR 2026-034) may declare `longRunning: "reads-tree" | "writes-tree"` and
`prepare?(cwd)`. Both are part of the gate registry contract, not sockets,
born with their consumers (`src/gate-jobs.ts`, `src/gate-job-worker.ts`).
`prepare` is a step whose own effects are not part of the evaluated run; a
result from it ends the call. The ts pack declares five long gates:
`deliver` and `mutation-score` (`writes-tree`: one changes the project's
files, the other writes a mutant at a time) and `green-gate`, `red-gate`,
`run-tests` (`reads-tree`). Its leftover-mutant restore (ADR 2026-070)
is every entry's `prepare`.

**Inline or detached is the host deadline's call.** Without
`BOUNDED_COMMAND_TIMEOUT_MS` (pi, a bare shell) a long gate runs in the call,
after collecting or waiting on any job a deadline-bound call started. With
one, the whole gate runs in a worker (`gate-job-worker.ts`) under a runner
(`job-runner.ts`) started with `detached: true` (its own session), stdio to
files, `unref()`. The call waits up to `callBudgetMs(deadline)` less what it
has already spent, then answers RUNNING. A run in the call is recorded as the
gate's run too (`inline`), so every call sees every run of a gate.

**A job** is `.bounded/jobs/<name>/` (`gate-<gate>` in a project,
`merge-<issue>` in the main worktree): `spec.json`, `job.json` (run id, the
runner's pid and its start time, host, start, limit, key, tree, deaths), the
`result-<id>.json` (exit codes only), each written whole. The run's raw
output and its payload live outside the project, in a temporary directory
the record names. Inspecting, starting, stopping and collecting happen under
`.bounded/jobs/lock`, held only for those moments and waited for no longer
than the call's budget (`src/detached-job.ts`).

- **Key and run id.** A job's key is the gate and its canonical arguments,
  never the role. Every run has a random id, and only the current run's
  result is ever read, so an abandoned run's late result is never collected.
- **Which runs overlap.** Never two runs of one gate, in a call or in the
  background, under any mix of deadlines: a call that finds the gate running
  in another call is refused ("running now in another call"). A `writes-tree`
  gate runs alone: it starts only when no other long run is live, and nothing
  starts beside it. `reads-tree` gates run alongside each other, which keeps
  ADR 2026-021's parallel red and `run_tests`. A refusal ran nothing: it is
  logged as the core's `job-refused` under `gate-job`, never as the gate's
  verdict, and neither the board nor the delivery snapshot hears of it. It
  names what is running in the calling role's terms, and never offers a gate
  the role cannot call.
- **Collection.** A live run with the same key is waited on; one with
  another key is stopped (`args-changed`). A finished run is collected over
  the tree it left: the worker records the tree (`src/tree-fingerprint.ts`)
  after `prepare` and after `run`, and a tree changed since discards the
  result and starts afresh (`tree-changed`). A `reads-tree` gate whose tree
  changed while it ran answers BLOCK, routed to the session's role, else the
  architect. A job recorded with another packs directory is discarded
  (`packs-changed`); only an in-process caller passes one, and the worker
  gets it on its own argv. A result is logged, the board updated (or its
  update left pending), and only then the job cleared.
- **Liveness and killing.** A run is alive while its runner's pid runs with
  the recorded start time on this host. On another host, or when the start
  time cannot be read, it counts as running until its limit plus a margin
  (the host-aware pattern of `mutation-journal.ts`). Its group is signalled
  only when provably the job's (the leader with its start time, or no
  process with that pid while its group lives): SIGTERM, wait 10 s, SIGKILL,
  wait 10 s; a group that survives is an ERROR, never a second run. Anything
  else is abandoned untouched.
- **Every job has a way out.** One limit for every job: 60 minutes, dead 5
  minutes past it. A run gone without a result, or past its limit and margin,
  is a death; three in a row for one key and tree answer ERROR ("died 3
  times in a row … a harness bug", routed to the user) until the key or the
  tree changes, or `bounded lead release` clears it. A worker that ends
  without a payload is an ERROR, never a restart.
- **Inside a job** the host deadline is the job's limit and `BOUNDED_JOB_DIR`
  is set. Advice to raise a command timeout is wrong there: the preflight's
  budget refusal becomes "this run's time limit … a harness bug", and
  mutation-score's remedy names only `--timeout-ms`.
- **No role reads job files.** `.bounded/jobs/**` is denied to every
  pipeline role, and the raw suite output is not in the project at all, so a
  search over `.bounded` still works.

**RUNNING.** `GateCode` is `0|1|2|3`. Only `gateRunning` builds code 3
(`verdict: "running"`); `gateCodeOf` still clamps a runner's own 3 to
ERROR, and a gate that returns 3 is turned into an ERROR. The line is
`<gate>: RUNNING (still working in the background; call <gate> again to
collect it)`, on stdout, exit 3; `--json` carries `verdict: "running"`,
`code: 3`; pi gives `ok: false`, `code: 3`. A long gate's description says
to call it again on RUNNING. The guard log's verdicts gain `running`:

- a job's start and restart are `running` events under the gate's own guard
  (`job-started`, `job-restarted`, with pid, run id and reason);
- every verdict the core substitutes for the gate's (the reads-tree BLOCK,
  "cannot answer RUNNING", whether by code or by verdict, no verdict, three
  deaths) is
  logged under the gate's own guard;
- the core guard `gate-job` carries only polls (`job-running`) and
  pass-through collection (`job-collected`), whose verdict the gate logged
  itself inside the job.

`deliveryState` and `readRunLog` accept `running`; a latest `deliver` event
that is running is undelivered. The board gets one comment when a job starts
or restarts, nothing on a poll, and no label or status; a RUNNING deliver
neither records nor clears the delivery snapshot. The contract is the
lead's decision on the user's behalf.

**Merge is resumable and never leaves local `main` unsafe.** `bounded lead
merge` runs the composed `projectCheckCommands` as job `merge-<issue>` in
the main worktree (`LeadDeps.check` is gone; the commands come from
`LeadDeps.packsDir`, else the main worktree's harness packs). After the
fetch, fast-forward and re-read of ADR 2026-072, it commits the delivered
work, records `phase: "merging"` with main's commit and the branch head,
merges, and records the merge commit.

- **Resume.** The architect, worker and live-gate-job checks are redone; the
  level checks are not, but it fetches to see whether the push landed. With
  no merge commit recorded: a half-done `git merge` is aborted; `main` at the
  recorded commit starts over; `main` at a merge of exactly the recorded
  commit and branch head is adopted; anything else is refused, untouched.
  With the merge commit recorded and already on `origin/main`, it finishes.
- **Collection.** HEAD other than the merge commit is the one refusal:
  "the main line moved off the merge … a harness bug", touching nothing. A
  check that failed, did not complete (no result, timed out, three deaths:
  "a harness bug") or saw a tracked change (`git status --porcelain
  --untracked-files=no`; untracked files never block) undoes. A passing check
  over a clean main is pushed; a refused push undoes.
- **Undo** is `git reset --hard <recorded commit>`, only after the job is
  collected or stopped and only while HEAD is still the merge commit. The
  phase then returns to `started`.
- **While a ticket merges**, `start`, another `merge`, its `reply` and its
  `sync-config` refuse; `sync-config` also refuses an uncollected gate job.
  `merge` refuses a live gate job in the worktree and clears finished ones.
  `status` names the merge and every background run.
- **`release`** stops the ticket's gate jobs and its merge's check (refusing
  live ones without `--force`) and undoes the merge, saying why the user
  holds it; over a merge the main line has moved off it leaves everything.
- **RUNNING for the lead.** `LeadOutcome.running`, exit 3, pi's
  `details.running`, a `running` lead event; one issue comment when the
  check starts or restarts. The Claude Code lead hook gives `bounded lead
  merge` alone the call's deadline (`BOUNDED_COMMAND_TIMEOUT_MS=<ms>`).

**The live probe.** `agent/test/claude-job-live.test.ts` (opt-in) runs one
Claude Code Bash call with a 20 s timeout whose script starts a setsid'd child
with stdio to files and exits. On Claude Code 2.1.289 the call returned as
soon as the script exited and the child wrote its marker 10 s later, after
the call and the session had ended.

## Why

Run 31: deliver's project check died twice at Claude Code's command limit,
silently, and the lead handed the user a command. Splitting work per gate
(ADR 2026-070's mutation budget) only covers a gate that can stop between
steps; a single project check cannot. Running the whole gate as the job puts
the mechanism in the core once, keeps prepared services inside the gate, and
lets any pack's long gate opt in with one field.

## Consequences

- On Claude Code a long gate takes several calls; each answers within its
  budget.
- A gate that needs more than an hour never completes, and says so.
- A job on another host is never killed; it is waited on until its limit.
- A role that edits the tree while a gate runs waits one more run.
- Red's shadow run and the builder's `run_tests` still overlap; `deliver` and
  the mutation measurement wait for every other long run, and they for it.
- A laptop that sleeps past a job's limit costs a restart, never a corrupt run.
- A main that moved off a merge is a harness bug release will not paper over.
- A slow check still costs its full time: this keeps calls short, it does
  not make checks faster.
