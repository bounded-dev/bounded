# 2026-062: Bun is the TypeScript projects' toolchain

**Status:** accepted

## Decision

For TypeScript projects, the ts pack contributes Bun: setup
`bun install --frozen-lockfile --ignore-scripts` with a probe for Bun's
install, `run_tests` via `bun test` with a JUnit report, and typecheck via
`bunx tsc -p tsconfig.json`. Shipped project scripts run with `bun`.
`bun.lock` is produced by `bun install --lockfile-only` whenever
manifests are generated. The config check verifies it resolves exactly the
generated pins, without network access. The npm, Vitest and Vite paths are
retired, and so is `ts-drizzle-sqlite`.

The harness itself stays on Node and npm; only the core may name its own
runtime (ADR 2026-051).

## Why

The worked example is a Bun monorepo: Bun installs, tests, bundles and
serves. Keeping npm and Vitest would make every generated project differ
from the reference.

## Consequences

`bun test` has no JSON reporter, so test results are read from JUnit. The
sanitised view the builder sees keeps test names and error messages only.
ADR 2026-055 is superseded.
