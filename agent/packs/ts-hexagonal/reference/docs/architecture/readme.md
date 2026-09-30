# Architecture

This repository is a Bun monorepo built on **hexagonal architecture** (ports and adapters) with **bounded contexts** from Domain-Driven Design. It deliberately does **not** use aggregates (see [domain.md](domain.md#no-aggregates)).

These documents are the rulebook. Where a rule says **must**, it is not optional; where it says **should**, deviate only with a stated reason. They are generated into the project and kept in sync by the harness; change them through the harness, not by hand.

## Documents

| Document | Covers |
|---|---|
| [directory-structure.md](directory-structure.md) | The full tree, and file and folder naming |
| [layers-and-dependencies.md](layers-and-dependencies.md) | The layers, the dependency rule, and how it is enforced |
| [domain.md](domain.md) | Value objects, entities, contracts, `Result`, no aggregates |
| [application.md](application.md) | Features, commands, handlers, in and out ports, CQRS |
| [adapters.md](adapters.md) | In and out adapters, per-feature stores, mappers, package exports |
| [apps-and-composition.md](apps-and-composition.md) | Apps, composition roots, entry files |
| [bounded-contexts.md](bounded-contexts.md) | Contexts, packages, communication between contexts |
| [persistence.md](persistence.md) | Postgres, Drizzle, schemas, migrations, local database |
| [error-handling.md](error-handling.md) | When to return a `Result` and when to throw |
| [testing.md](testing.md) | Test levels and what each one covers |
| [agent-workflow.md](agent-workflow.md) | How the architect, test and builder agents split the work |

## The rules on one page

1. **Dependencies point inwards:** domain ← application ← adapters ← apps. Nothing inside depends on anything outside.
2. **One package per bounded context,** with layers as folders and one export path per layer (and per adapter technology).
3. **Contexts never import each other.** They communicate through their own out ports and adapters, or through events.
4. **Everything is grouped by business area** (plural folder name). Inside the application and adapter layers, each area is split by feature.
5. **Every feature has one file per layer:** contract, command (if it has input), handler, one store per storage technology, one in-adapter file per technology it is exposed through.
6. **Contracts live in `*.contract.ts` files.** Implementations are typed against them.
7. **Value objects validate themselves** through `static parse(raw): Result<T>`. Nothing else constructs them.
8. **Expected failures are `Result` values; bugs and infrastructure failures throw.**
9. **No aggregates, no per-entity repositories.** Each feature declares exactly the data it needs through its own out port.
10. **Every app has an explicit `composition-root.ts`.** It is the only place that chooses adapters. Entry files only host what it returns.
11. **Adapters are split by direction first (`in/`, `out/`), then by technology, then by area.**
12. **The browser only ever imports server code as types** (`import type`).
13. **Everything mechanical is generated from the contracts:** barrels, `Result`, commands, in adapters, and the skeletons of handlers and out adapters. People and agents write contracts, tests and implementation bodies.

## Toolchain

Bun is the package manager, test runner, bundler and runtime: `bun install`, `bun test`, `bunx tsc -p tsconfig.json`, `bun build`. Lambdas are bundled for Node with `bun build --target node`.

## Decisions

- **Desktop shell:** Electron. Its main process runs on Node and calls the tRPC router in-process (`createCaller`); the renderer is a browser and imports server code as types only.
- **Cross-context calls:** an out adapter of the consumer (`contexts/<consumer>/src/adapters/out/**`) may import the provider's `@<scope>/<provider>/application` and nothing else of it. `architecture.test.ts` already allows exactly that, so the first cross-context dependency needs no change to the test.
