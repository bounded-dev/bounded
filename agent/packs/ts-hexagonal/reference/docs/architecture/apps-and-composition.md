# Apps and composition

An **app** is one deployable thing: a web server, a desktop shell, an MCP server, a set of Lambdas. Apps contain no business logic; they only decide which adapters to use and host the result. Each app is declared in the design (a ticket note's `workspaces:` map), and its package, entry files and composition root are generated from that.

## Composition root

Every app **must** have a `composition-root.ts`. It is generated from the design and nobody edits it. It is the only place that:

- chooses which out adapter backs each out port,
- chooses the database driver and other infrastructure clients,
- constructs handlers, passing the out adapters into their constructors,
- constructs the in adapter, passing it the handlers as in ports,

and returns the finished in adapter (a router, an MCP server, a Lambda function).

```ts
// composition-root.ts
export function composeApp(): ContextRouter {
  const db = drizzle(connectionUrl());

  return createContextRouter({
    items: {
      create: new CreateItemHandler(new DrizzleCreateItemStore(db)),
      list: new ListItemsHandler(new DrizzleListItemsStore(db)),
    },
  });
}
```

- Dependencies are grouped by area, as the router nests them (`items.create`). The tRPC router, the MCP server and each Lambda factory take this shape.
- Infrastructure (the database) is created once and shared. Its URL comes only from the environment, never with a fallback.
- Returns something ready to host. It does not start servers or listen on ports.
- An app with several entry points (for example Lambdas) has **one `compose<Entry>()` function per entry point** in the same file.
- Tests call the composition root to get a fully wired app without starting a server: every app has one smoke test next to it.

## Entry files

The entry file only hosts what the composition root returns. It imports nothing from a context except types.

| App kind | Entry file | What it does |
|---|---|---|
| Web | `src/server/main.ts` | `Bun.serve()` with the page route and `/trpc/*` |
| MCP | `src/main.ts` | `composeApp().connect(transport)` |
| Lambda | `src/<function>.ts` | `export const handler = compose<Function>();` |
| Desktop | `src/main/main.ts` | Opens the window and connects the UI to the router |

Anything built at module level in a Lambda entry file is built once per cold start and reused across invocations.

## Web app layout

```
apps/web/src/
  client/
    index.html
    main.tsx
  server/
    composition-root.ts
    composition-root.test.ts
    main.ts
    seed.ts
```

- `client/` runs in the browser; `server/` runs in Bun. `Bun.serve()` bundles the client from its HTML import.
- The server serves the page and the API from one origin.

## Desktop app

The desktop shell is Electron. `src/main/` runs on Node, composes the router and calls it in-process with `createCaller`; `src/renderer/` is a browser page and, like `client/`, imports server code as types only.

## Seed data

Development seed data **must** go through the public API (for example `router.createCaller({})`), not straight into the database. Seed data then passes the same validation as real requests. A seed that runs on every start needs a guard once the database persists.

## Runtimes

- Bun is the package manager, bundler, test runner and the runtime for web and MCP apps.
- **Lambdas run on Node.** They are bundled with `bun build --target node` and must not use Bun-only APIs.
- Each composition root uses the database driver that suits its runtime (see [persistence.md](persistence.md)).
