# 2026-064: Store tests need a container runtime only at green

**Status:** accepted

## Decision

Store tests run against real Postgres through Testcontainers, started lazily
by generated test support on first use.

- **Red** must never need a container runtime. When one is unavailable, the
  red gate skips the store tests and logs why. Red evidence still covers
  every other level.
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
