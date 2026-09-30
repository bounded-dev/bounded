# Testing

All tests run with `bun test`. Test files are named `*.test.ts` (or `*.test.tsx`) and sit next to the code they test; shared test code is `*.test-support.ts`. Files ending `.laws.test.ts` are generated.

## Levels

| Level | File | Tests | Uses | Needs |
|---|---|---|---|---|
| **Architecture** | `architecture.test.ts` (generated) | The dependency rule, context isolation, browser type-only imports | Source file scanning | Nothing |
| **Domain laws** | `<concept>.laws.test.ts` (generated) | What every value object, identifier and entity must obey | The classes directly | Nothing |
| **Domain unit** | `<concept>.test.ts` | Value object `parse`, `equals`, entity behaviour | The classes directly | Nothing |
| **Command laws** | `<feature>.command.laws.test.ts` (generated) | Wire refusal and field-by-field validation | The command | Nothing |
| **Handler** | `<feature>.test.ts` | Each feature's `execute`, including its `Result` failures | Fakes of the feature's out ports, written inline | Nothing |
| **Store conformance** | `<feature>.store.test-support.ts` | What every store for the feature must do | A factory for the store under test | — |
| **Store** | `adapters/out/<tech>/<area>/<feature>.store.test.ts` | Runs the conformance suite against one storage technology | In memory, or Postgres via Testcontainers | Docker, for Postgres |
| **Other out adapter** | `adapters/out/<tech>/<area>/<feature>.<role>.test.ts` | The adapter against its port | The adapter directly | Depends on the technology |
| **In adapter** | `adapters/in/<tech>/<area>/<feature>.<kind>.laws.test.ts` (generated) | Input validation, `Result` mapping, `toJSON` output | The context's adapter factories with fake in ports | Nothing |
| **App smoke** | `composition-root.test.ts` next to the composition root | The wired app answers through its in adapter | `compose<Entry>()`, in process | Whatever the app composes |
| **End-to-end** | — | User journeys through the running web app in a browser | The real app against the real database | Docker, a browser (not yet in use) |

## Rules

- **Handler tests never touch a database.** A handler test that needs Postgres is testing the store, not the handler. Construct the handler with fakes, in the constructor's order: `new CreateItemHandler(fakeStore)`.
- **Every store is tested through its feature's conformance suite,** once per storage technology. The suite takes a factory, so each technology supplies a fresh store and the seeding the port itself cannot do.
- **Postgres store tests use real Postgres via Testcontainers,** never an embedded substitute. They start the container lazily on first use. Without a container runtime they are skipped, with the reason logged, while the tests are being written; they must run, and pass, before the work is accepted.
- **In adapters are generated, and so are their tests.** Nobody writes tests under `adapters/in/`.
- **App smoke tests run once the app is built,** because the composition root is the builder's work.
- **Test against contracts.** A test imports the in port or out port it exercises and treats the implementation as replaceable.
- **Fakes implement the feature's own out port.** Because out ports are per feature, a fake only has to implement what that feature uses.
- **One behaviour per test.**
- The architecture test must keep passing. A failure means a layer or context boundary was crossed.
