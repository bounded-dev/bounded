---
name: ts-api-service
description: Design a TypeScript API the reference way — expose a context's features to callers over the network with typed access for a frontend, an agent (MCP) or a scheduled job (Lambda). Use whenever a ticket asks to expose data or operations to callers, add an API, HTTP, RPC or MCP endpoint, give a frontend access, or make a feature callable from outside the process. Covers the @exposedVia tag, what is generated, and what the gates enforce.
---

# Exposing features (ADR 2026-060, ADR 2026-063, TN-26-012 §4 and §6)

A ticket that says "expose this to the frontend" — in any words, naming any
technology or none — lands here. **The stack is harness policy, not ticket
content** (ADR 2026-029): tRPC for the frontend (`ts-trpc`), the MCP SDK for
agents (`ts-mcp`), AWS Lambda for scheduled or event work (`ts-lambda`). A
ticket naming a different stack is the intake rule's constraint case (ADR
2026-032).

## The architect's whole job: one tag

In-adapters are **generated** from the feature contract. The architect
decides which features are exposed and how, with one JSDoc tag on the in
port:

```ts
/**
 * Create a project
 * @exposedVia trpc mcp
 */
export interface CreateProject {
  execute(command: CreateProjectCommand): Promise<Project>;
}
```

- Every id must be a composed in technology: `trpc`, `mcp`, `lambda`.
- The summary line is required for `mcp`: it becomes the tool description.
- No tag, no adapter.

## What is generated (write-protected, drift-checked)

| Technology | Files under `contexts/<context>/src/adapters/in/<tech>/` |
|---|---|
| trpc | `trpc.ts`, `router.ts` (`create<Context>Router`, `type <Context>Router`), `<area>/<area>.router.ts`, `<area>/<feature>.procedure.ts`, `index.ts` |
| mcp | `server.ts` (`create<Context>McpServer`), `<area>/<feature>.tool.ts` (tool `snake_case(feature)`), `index.ts` |
| lambda | `<area>/<feature>.lambda.ts` (`create<Feature>Lambda`), `index.ts` |

Route keys are `routeKey(area, feature)`: `projects/create-project` is
`projects.create`. Each technology also gets generated **adapter laws**,
`<feature>.<role>.laws.test.ts`: input the command refuses never reaches the
in port, valid input calls `execute` exactly once with the parsed command,
and what comes back is plain `toJSON` data. Nobody writes tests under
`adapters/in/`.

## What the builder writes

Not the composition roots: each app's (`composeApp()`, or one
`compose<Feature>()` per Lambda) is generated too (ADR 2026-066). It builds
every handler with its stores and passes them to the generated factory,
grouped by area as the router nests them:
`createProjectManagementRouter({ notes: { create, list }, projects: { … } })`.
The builder writes the handlers, stores and app entry files. The gates
enforce:

- `bounded-ts-trpc/raw-framework-entry` — no `initTRPC` outside the
  generated adapter; serve the router through `@trpc/server/adapters/fetch`.
- `bounded-ts-trpc/no-erased-router` — no `AnyRouter` or other erased type
  (also in contracts, for the architect).
- `bounded-ts-trpc/router-type-reexported` — a tRPC client is typed by the
  router type the adapter re-exports.
- `bounded-ts-lambda/no-bun-api` — an app bundled with `--target node`
  (Lambdas, an Electron main process) uses no Bun runtime API.

Delivery's `trpc-obligation` blocks a project that composed `ts-trpc` but
exposes nothing through it.
