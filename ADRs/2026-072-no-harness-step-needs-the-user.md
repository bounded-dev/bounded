# 2026-072: No harness step needs the user

**Status:** accepted

## Decision

A project's user describes what they want and answers product questions;
they never run a harness step (`AGENTS.md`). Issue #52 removes the steps the
harness still handed them.

**A hung container engine is refused within seconds.** The probe asks each
endpoint `GET /_ping` and then `GET /version` in one child, each within 3 s,
the child bounded by `2 × timeout + 2 s`. A ping without a version answer is
"the container engine is not responding". The probe runs in each policy's
`decide`, before anything is prepared.

**Refusals only the user can clear say so.** The ts `PhaseTestDecision`
refusal gains `route?: "user"`; `combineDecisions` sets
`PhaseRun.refusalRoute = "user"` only when every refusal carries it. A
`prepare` rejecting with an error whose `route` is `"user"` routes the same
way. Green, deliver and `run_tests` print `<gate>: route → user` and set
`detail.route`. The engine refusals, the preflight's failures and green's
all-infrastructure verdict carry it, with remedies in product terms and no
command ("the container engine isn't running: start it"). The developer
stage's route list gains `user`: the architect stops and reports to the team
lead, which tells the user.

**No preparation stage outlives the host's call.** `callBudgetMs` moves to
core `host.ts` (ADR 2026-070's budget, which `mutationBudgetMs` now
delegates to). The Testcontainers preflight runs each stage on
`min(clock, remaining budget)`: runtime 60 s, start 180 s, and the pull a
60 s stall clock re-armed by each line of Testcontainers' own pull log
(`testcontainers:pull`, forwarded by the child as progress), capped at
1800 s. A stage whose minimum (10, 30, 30 s) no longer fits is refused
before it starts, routed to the calling role: "call the gate again with a
longer command timeout". `PULL_TIMEOUT_MS` is retired.

**The project's own check needs only a container engine.** ts-drizzle-postgres
emits a generated `app-test-database.test-support.ts` beside each persisting
app's composition root. Its `useAppDatabase()` starts one Testcontainers
Postgres per file, applies every context's migrations with each context's
own table, and points `DATABASE_URL` at it (restored afterwards). The
location comes from a new optional `compositionRoot` field on app workspace
templates (the ts pack's `workspaceTemplates` socket; web, mcp, lambda and
desktop declare it). The drizzle `appPins` give every app the dev
dependencies the support imports, and `generatedFileGlobs` gains
`apps/**/app-test-database.test-support.ts`. The `drizzle-app-database`
obligation (green phase) requires `useAppDatabase()`, imported from the
support, as the first statement after the imports, and no `compose…()` call
reachable while the file loads (module scope, `describe` callbacks including
`describe.each`, functions called on the spot, and named helpers those call); green
and deliver check green obligations before anything runs, routed to the
test-writer. The gates no longer start an application database
(`startAppDatabase` is gone); the preflight covers store tests and persisting
smoke tests. No env mechanism is added: the support overrides `.env` and
inherited values itself.

**The lead restores config; `sync-config` is born as a data socket.** A pack
names which of its `projectCommands` restores generated config in
`projectConfigSyncCommand` (the ts pack: `sync-config`); its consumer is
`bounded lead sync-config <issue>` (pi: `lead_sync_config`). It runs in a
started ticket's worktree, never while its architect or a background worker
runs, reopens an Awaiting Merge ticket to Building and clears its delivery
snapshot, and is used only after the user agrees. Socket and script are read
from one packs directory, the main worktree's `.bounded/harness/packs`. None,
more than one, or a malformed contribution refuses, naming the pack. Drift
refusals now say "escalate to the team lead".

**`merge` brings `main` level itself.** A clean `main` strictly behind
`origin/main` is fast-forwarded (`--ff-only`) and re-read, so a failing check
undoes to the fast-forwarded commit. A diverged `main` is refused in product
terms (follow-up #55).

**Three reserved recovery commands.** `USER_RECOVERY_COMMANDS` in
`lead-policy.ts` is `["bounded lead release", "gh auth login", "gh auth
refresh -s project"]`; every message naming one says why: the harness cannot
prove a seat's session is gone, and signing in to GitHub, or granting that
sign-in project access, acts on the user's own credentials, which the harness
never holds. A tracker failure reaches the user only as a `TrackerError`
message in product terms (sign-in needed, project access needed, repository
or board not found, GitHub unreachable); `gh`'s own output, which can name
commands, is kept in the error's `raw` for the guard log's detail. Every line of an output routed to the user (`route →
user`), the composed message included, names no other command.

**Two named, temporary exceptions**, each saying so: the team lead's "Release
a dependency" section (#54), and naming `db:generate` for an ambiguous schema
change (#57). Drift tests (`user-steps-drift.test.ts`,
`user-refusals.test.ts`) hold every brief, skill and source string addressing
the user to this.

## Why

Run 31's delivery died inside one host command while a hung engine stalled
the preparation for over half an hour, and the lead then handed the user
`! bun run check`, which outside the gate needed `.env`, `db:up` and
`db:migrate`. Each of those is a harness step the user should never see.

## Consequences

- Existing persisting projects see a one-time drift: app manifests and the
  lockfile (the new dev dependencies) and a newly generated support file.
  The next design gate writes the file; the lead's `sync-config`, with the
  user's agreement, restores the manifests and lockfile. Smoke tests must
  then call `useAppDatabase()`.
- The harness cannot stop a model improvising advice in free text, or a user
  running their own shell; it makes `.env`, `db:up` and `db:migrate`
  unnecessary to every step and keeps its own text from pointing there.
- Follow-ups: #53 (detached, resumable long steps), #54 (the dependency
  handoff), #55 (a diverged `main`), #56 (refusals that ask for `.bounded/`
  edits), #57 (the ambiguous-rename generation).
