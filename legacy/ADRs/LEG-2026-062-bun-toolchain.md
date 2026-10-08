# LEG-2026-062: Bun is the TypeScript projects' toolchain

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
runtime (ADR LEG-2026-051).

## Why

The worked example is a Bun monorepo: Bun installs, tests, bundles and
serves. Keeping npm and Vitest would make every generated project differ
from the reference.

## Consequences

`bun test` has no JSON reporter, so test results are read from JUnit. The
sanitised view the builder sees keeps test names and error messages only.
ADR LEG-2026-055 is superseded.

## How the builder's test view is kept blind, and its known limits

`run_tests` reads test names and statuses from bun's JUnit report, and error
text from bun's console report. That text is taken only from inside a window
that starts after bun's own caret line. A `(fail)` marker counts only when it
carries bun's duration, for a test the report lists as failed. Every line of
every test file is dropped. A run with no report shows fixed text. Bun runs
with `CI=true`, so a run never writes a snapshot, and inherited `BUN_*`
variables are removed. A preload silences console output in the test
process. The lockfile check compares every entry against the fingerprint of
the clean resolution recorded when bun produced it.

These limits remain:

- **JavaScriptCore fragments.** The engine's own messages can quote an
  expression from the test (`undefined is not an object (evaluating
  'secretVarName.propertyFromTest')`). A fragment is not a whole line, so the
  forbidden-line filter keeps it.
- **Builder code that reads test files at runtime.** Implementation code
  could read a test file itself and put an encoding of it (base64, one
  changed character per line) into an error message. The filter matches
  lines of source, not encodings. The defence is lint: no domain or
  application code does I/O.
- **Raw writes to the error stream.** A test that writes to file descriptor 2
  without `console` or `process.stderr` (a child process, a native call) can
  still imitate a marker. The JUnit check limits what that can move, but it
  cannot rule it out.
- **The lockfile fingerprint** lives in `.bounded/lockfile-fingerprint.json`.
  It protects against an edited lockfile, not against a compromised registry
  at the moment of resolution.
