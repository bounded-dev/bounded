# Layers and dependencies

## The layers

| Layer | Contains | May depend on |
|---|---|---|
| **domain** | Value objects, entities, business rules, `Result` | Nothing except libraries with no side effects (currently `zod`) |
| **application** | Features: commands, handlers, in ports, out ports | domain, `zod` |
| **adapters/in** | Translate an outside trigger into an in-port call (HTTP, tRPC, MCP, Lambda, CLI) | application (in ports and commands), domain, the technology's library |
| **adapters/out** | Implement out ports with a technology (database, file, API, queue) | application (out ports), domain, the technology's library |
| **apps** | Composition roots and entry files | everything in the contexts they use, through their export paths |

The domain and application layers together are "the hexagon". They contain no I/O, no framework code and no knowledge of how they are called or where data lives.

## The dependency rule

Dependencies point inwards only:

```
apps → adapters → application → domain
```

- domain **must not** import application or adapters.
- application **must not** import adapters.
- An adapter **must not** import another adapter: not another technology, and not the other direction.
- In adapters **must** depend on in-port **interfaces** (`CreateItem`), never on handler classes (`CreateItemHandler`). Only the composition root knows the handler classes.
- Out adapters implement out-port interfaces and are never imported by the application layer.
- Inside a context, the domain imports its own files by relative path only; the application imports its own feature's files by relative path and the domain through its barrel (`@<scope>/<context>/domain`); adapters import the application and the domain through the context's own export paths.

## Ports

A **port** is an interface owned by the application layer.

- **In port (driving):** what a feature offers. Declared in `<feature>.contract.ts`, implemented by `<feature>.handler.ts`, called by in adapters.
- **Out port (driven):** what a feature needs from the outside world. Declared in the **same** `<feature>.contract.ts`, implemented by out adapters, injected into the handler's constructor.

An **adapter** is the technology-specific code on either side of a port. A tRPC procedure is an in adapter, not a port.

## Enforcement

- **`architecture.test.ts`** (run with `bun test`) reads every import of every file under `contexts/*/src` and `apps/*/src` with the TypeScript parser: static, side-effect, re-export, `import x = require()`, `require()`, dynamic `import()` and `import("…").Type`. It fails when:
  - a context file sits outside `domain/`, `application/` and `adapters/in|out/<tech>/`,
  - domain imports application or adapters, application imports adapters, or an adapter imports another adapter,
  - domain or application code imports a library other than `zod` (tests excepted),
  - a context imports another context (except an out adapter calling the other context's `application`) or an app,
  - an app imports another app, reaches outside its own `src/` by relative path, or imports a context other than through its export paths,
  - browser code (`client/`, `renderer/`) imports server code other than with `import type`,
  - an in adapter uses a handler class.
- **Lint rules** check the same boundaries as each file is written, plus the file-role suffixes, naming, handler shape, and that only composition roots construct handlers and adapters.
- **Package boundaries:** Bun installs each workspace package's dependencies in isolation, so a package can only import what its `package.json` declares.
- **Type checking:** `bunx tsc -p tsconfig.json` type-checks every context and app together.

A change that breaks any of these checks is wrong, even if it works at runtime.
