# 2026-064: Store tests need a container runtime only at green

**Status:** accepted

## Decision

Store tests run against real Postgres through Testcontainers, started lazily
by generated test support on first use.

- **Red** never runs store tests, whether or not a container runtime
  answers, and logs why. They apply the context's migrations, which
  generate-artifacts only produces from the builder's schema after red, so at
  red they could only fail for that missing file, never for
  `NotImplementedError`. Red evidence still covers every other level.
- **Green** refuses, with a clear message, when store tests exist and no
  container runtime is available. It never passes by skipping them.
- Unit, handler and in-adapter tests must not need a container runtime.

## Why

A skipped store test that counts as a pass would let an unverified store
ship. A red phase that needs Docker would block design work on machines
without it, where no store has been built yet.

## Consequences

A project with stores can only be delivered on a machine with a container
runtime.

The rule reaches the gates through a ts-owned socket, `phaseTestPolicies`
(`agent/packs/ts/pack.ts`): the ts pack cannot import the pack that knows
what a store test is. ts-drizzle-postgres contributes it. Red sets the skip
in the test process's environment, never its own, and sets aside only the
skipped results the policy claims (the `Drizzle<Port>Store` blocks); green
removes the variables, refuses when a runtime is needed and absent, and
refuses any skipped or todo result.

**Amendment — the green run's application database (superseded by ADR
2026-072: the gates start no database; each persisting app's smoke tests
start their own through the generated `app-test-database.test-support.ts`,
required by the `drizzle-app-database` obligation; green and the build run
remove any inherited `DATABASE_URL` from the test process).** Apps persist through
Drizzle, and their composition roots connect to `process.env.DATABASE_URL`,
so the app smoke tests need a migrated Postgres too. A policy decision to run
may carry `prepare`, which returns a `PreparedTestService` (environment plus
`release`). At green, on a tree that persists through Drizzle, the policy
starts one throwaway container from the pinned image through the docker CLI
on the probed endpoint, applies every context's migrations, and the gate sets
its URL as `DATABASE_URL` over any inherited value and releases the container
after the run, on failure too (`withPreparedServices`). Without a runtime
such a tree is refused at green even before it has a store test.

**Amendment — Testcontainers preflight and the machine's failures.** The
gate's database goes through the docker CLI, the store tests through
Testcontainers, and only the second can fail for a credential helper missing
from PATH, an unreachable registry, a socket Testcontainers does not use, or
a reaper (Ryuk) that cannot start; those failures used to reach the builder
as failing store tests. So at green, with store tests and a runtime, the
policy's `prepare` (which now receives the run's environment change) first
starts and stops one container from the pinned image per distinct
Testcontainers the contexts resolve, in a `bun` child resolving it from the
store tests' directory, in exactly the test process's environment. The pull
has its own timeout; the child removes its container through Testcontainers'
own client, and the parent sweeps the run's label on the runtime the child
reported, again after a grace period if it was killed. Failure refuses green,
mutation score and deliver's check with the cleaned cause and a remedy,
routed to the user since ADR 2026-072 (in product terms, no command). As a backstop, a run decision may carry
`infrastructureFailure`: it claims only text Docker or Testcontainers produce,
and green routes to the orchestrator only when every failure is claimed;
otherwise the route stays the code's, with the machine's causes as a note.
Since ADR 2026-072 the probe asks for the engine's version after its ping
(a hung engine is refused within seconds, routed to the user), the preflight
also covers persisting apps' smoke tests, and each of its stages fits the
call's remaining budget, the pull on a stall clock re-armed by Testcontainers'
own progress. Mutation score refuses a run the machine failed rather than count mutants
killed. Known limit: deliver's check runs `bun run check` as text, so it
gets the preflight but not the backstop. The core learns no technology: the
patterns are the pack's (`testcontainers-preflight.ts`).

**Amendment — the builder's run (issue #48).** The builder's `run_tests` had
no database, so the app smoke tests failed on every builder run and the
builder reported BLOCKED over the machine's gap. A third phase, `build`,
joins red and green in `phaseTestPolicies`, and `run_tests` applies it. A run
decision may now carry `exclude` (project-relative test files and a reason).
It is allowed only at build; at red or green it is a policy defect, read as a
refusal. `run_tests` starts what the policies prepare, prints each
exclusion's reason before the results, and logs the excluded files. A service
that cannot start is an error with its reason, and nothing runs. At build the
Postgres pack does what green does where it can: the Testcontainers preflight
(since ADR 2026-072 there is no gate database to start).
Without a container runtime, or while a Drizzle context has no committed
migration yet, it leaves the store tests and the app smoke tests out, naming
the cause and that green runs them. Exclusion is by file list, never through
the store-test skip variable, so no generated file changes. The app smoke
test file name is ts-hexagonal's, imported across the declared pack edge.
