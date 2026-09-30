# Agent workflow

The codebase is designed so that separate agents can build one feature in parallel, with contracts as the hand-off between them. Everything a generator can derive from the contracts is generated, so no agent writes it.

## Roles

| Agent | Writes | Must not touch |
|---|---|---|
| **Architect** | `*.contract.ts` files (domain concepts, feature contracts with their `@exposedVia` and `@implementedBy` tags), and the apps in the design's `workspaces:` map | Implementations, tests |
| **Test** | `*.test.ts` and `*.test-support.ts` files, written against the contracts | Contracts, implementations, generated files |
| **Builder** | Implementation bodies: domain classes, handlers, stores and other out adapters, mappers, Drizzle table definitions, composition-root wiring | Contracts, tests, generated files |

Generated, and written by no agent: the barrels (`index.ts`), `domain/shared/result.ts`, commands and their wire schemas, in adapters, migrations, laws tests, package manifests, `architecture.test.ts` and this documentation. Skeletons of domain classes, handlers, stores and out adapters are generated once from the contracts; the builder fills in their bodies.

The test agent never reads implementation files and the builder never reads test files; both read contracts and generated files.

## Why the structure supports it

- **One feature is one unit of work.** Every feature has a predictable file in each layer with the same name, so any agent can find its part.
- **Contracts are separate, readable files.** The shape of a concept or feature can be read without reading any implementation.
- **The compiler checks the hand-off.** Implementations `implements` their contracts, and domain implementations are exported through their `<Name>Factory` type, so a builder cannot drift from what the architect specified.
- **Contract files never import implementations,** so the architect can write every contract before any implementation exists.
- **Constructors are fixed by the contracts.** A handler takes its out ports in declaration order and a store takes its database object, so tests can construct both before either is built.
- **Per-feature out ports keep work isolated.** Building one feature never requires changing another feature's port or store.
- **The architecture test catches boundary violations** automatically, whichever agent introduces them.

## Adding a feature

1. **Architect:** create `application/<area>/<feature>/<feature>.contract.ts` with the in port and the feature's out ports, tagged with the technologies that expose and implement them. Add or extend domain contracts if new concepts are needed.
2. **Generators:** the command, barrels, in adapters and the skeletons of the handler and out adapters appear.
3. **Test:** write the handler tests against the in port, with fakes of the out ports. Write the store conformance suite, and one store test per storage technology that runs it.
4. **Builder:** implement the handler, each store and out adapter, and the domain classes. Wire them into the composition roots of the apps that expose the feature.
5. **Checks:** `bun test` and `bunx tsc -p tsconfig.json` must both pass.
