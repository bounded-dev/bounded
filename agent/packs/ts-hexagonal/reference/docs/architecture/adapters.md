# Adapters

Adapters are the technology-specific code on either side of the hexagon.

## Organisation

```
adapters/
  in/                          drive the application (something outside calls in); generated
    <tech>/
      index.ts
      <tech-root files>
      <area>/
        <area>.<aggregator>.ts
        <feature>.<kind>.ts
  out/                         driven by the application (the application calls out)
    <tech>/
      index.ts                 generated
      <tech>-database.ts
      <area>/
        <feature>.<role>.ts
        <concept>.mapper.ts
```

Split by **direction** first, then **technology**, then **area**, then one file per **feature**. Files that belong to a whole technology (the tRPC initialisation, the combined router, the shared database object) sit at the technology's root.

## In adapters

An in adapter turns an outside trigger into an in-port call. In adapters are **generated** from the contracts: a feature gets one for each technology its in port names in `@exposedVia`. Every in adapter follows the same steps:

1. Receive raw input from the framework, validated against `<feature>Schema` where the framework supports it.
2. `Command.parse(input)`. On failure, return the `Result` as data (or the framework's error format).
3. Call the **in-port interface's** `execute`.
4. Turn domain objects into plain data with `toJSON()` before returning them. Class instances never cross the wire.

Each in adapter receives the in ports it needs as parameters. It never constructs handlers or stores, and never names a handler class.

| Technology | Feature file | Aggregator | Technology root |
|---|---|---|---|
| tRPC | `<feature>.procedure.ts` exports `<feature>Procedure(inPort)` | `<area>.router.ts` | `trpc.ts` (the single `initTRPC` instance), `router.ts` (combines every area into one context router) |
| MCP | `<feature>.tool.ts` exports `register<Feature>Tool(server, inPort)` | none | `server.ts` creates the server and registers the tools; the app picks the transport |
| Lambda | `<feature>.lambda.ts` exports `create<Feature>Lambda(inPort)` | none | none |

Other in adapters (REST/OpenAPI, CLI, queue consumers) follow the same pattern under `adapters/in/<tech>/`.

- All tRPC routers in a context share the one `t` from `trpc.ts`; routers from different `initTRPC` instances cannot be combined.
- A tRPC procedure returns `{ ok, value }` / `{ ok, error }`, so the client gets typed business errors.
- An MCP tool reuses `<feature>Schema.shape` as its `inputSchema`, and reports failures as `isError: true` results.

## Out adapters

### One store per feature

Every feature's store port gets its **own** adapter class per storage technology, even when it looks the same as another:

```ts
// out/drizzle/items/create-item.store.ts
export class DrizzleCreateItemStore implements CreateItemStore {
  constructor(private readonly db: DrizzleDatabase) {}

  async groupExists(id: GroupId): Promise<boolean> { /* query written for this feature */ }
  async save(item: Item): Promise<void> { /* insert */ }
}
```

- **Never** one large store implementing every port, and **never** a repository per entity.
- Stores share the technology's **database object** (`<Tech>Database`), which the composition root passes into each constructor. The constructor is exactly `(private readonly db: <Tech>Database)`. That object is the only thing they share.
- A store may read from any area's tables: that is how a feature crosses areas without aggregates.
- Two stores with identical code today stay separate; the duplication is deliberate.
- Skeletons of every store, for every storage technology, are generated from the contracts; the builder writes the bodies.

### Mappers

`<concept>.mapper.ts` converts between a stored row and a domain object. It rebuilds value objects with `parse`. **A stored row that fails to parse is corrupt data, so the mapper throws** rather than returning a `Result`.

### Other out adapters

Anything the application needs from outside is an out port with an out adapter: exporters, notification senders, LLM clients, other contexts' APIs. **File formats (CSV, JSON) and destinations (S3, disk) are adapter concerns.** The feature only says what it needs ("export these things").

The port's `@implementedBy <tech>` tag names the technologies that implement it; each gets a generated skeleton, `<Tech><Port>` in `out/<tech>/<area>/<feature>.<role>.ts`. Local stand-ins, such as a console exporter in place of S3, live under their own technology folder (`out/console/`).

## Package exports

Adapters are exported **per technology**. There is no adapters barrel.

```json
"exports": {
  "./domain": "./src/domain/index.ts",
  "./application": "./src/application/index.ts",
  "./adapters/trpc": "./src/adapters/in/trpc/index.ts",
  "./adapters/drizzle": "./src/adapters/out/drizzle/index.ts"
}
```

Each app then bundles only the technologies it uses: a Lambda never pulls in tRPC, and the web app never pulls in the AWS SDK. The manifests and every `index.ts` are generated.

## Browser code

The browser imports the router **type only**:

```ts
import type { ContextRouter } from "@<scope>/<context>/adapters/trpc";
```

This gives the client full type safety without bundling any server code. A value import of server code into `client/` is a bug, and so is `import { type … }`, which still loads the module.
