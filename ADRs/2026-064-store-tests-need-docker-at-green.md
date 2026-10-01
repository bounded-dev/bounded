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

**Amendment — the green run's application database.** Apps persist through
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
routed to the orchestrator. As a backstop, a run decision may carry
`infrastructureFailure`: it claims only text Docker or Testcontainers produce,
and green routes to the orchestrator only when every failure is claimed;
otherwise the route stays the code's, with the machine's causes as a note.
Mutation score refuses a run the machine failed rather than count mutants
killed. Known limit: deliver's check runs `bun run check` as text, so it
gets the preflight but not the backstop. The core learns no technology: the
patterns are the pack's (`testcontainers-preflight.ts`).
