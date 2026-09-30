---
name: ts-web-app
description: Design a TypeScript web app the reference way — a screen, page, dashboard or form a person uses in a browser, served by the same Bun process that hosts the context's API. Use whenever a ticket asks for a UI, a screen, a view, a dashboard, a form, something a user sees or clicks, or asks to show data to people. Covers the web app workspace, what is generated, the typed client, and what the gates enforce.
---

# The web app (ADR 2026-063, TN-26-012)

A ticket that says "project managers need to see their projects" — in any
words, naming any technology or none — lands here. **The stack is harness
policy, not ticket content** (ADR 2026-029): Bun serves and bundles, React
renders, `@trpc/client` talks to the context's generated tRPC router, all
pinned by the web app's template. A ticket naming Vite, Next.js, Vue, MUI or
styled-components is the intake rule's constraint case (ADR 2026-032): strip
it, record it in `spec.md`'s `## Intake`, and raise it if it is genuine.

## The shape

A web app is one workspace, declared in a TN's front matter:

```yaml
workspaces:
  apps/web: web
```

It hosts exactly one context: the one whose features are tagged
`@exposedVia trpc`. The design gate seeds it from the design (skeletons,
yours to fill in):

| File | What it is |
|---|---|
| `apps/web/src/server/main.ts` | `Bun.serve`: the client page at `/` (an HTML import), the router at `/trpc/*` |
| `apps/web/src/server/composition-root.ts` | `composeApp()`: the one place handlers get their stores |
| `apps/web/src/client/index.html` | the page, titled after the context |
| `apps/web/src/client/main.tsx` | a React root with `createTRPCClient<ProjectManagementRouter>` |

The procedures, routers and the router type are generated into the context's
`adapters/in/trpc/` and are write-protected. The client imports the router
**type only**, from `@<scope>/<context>/adapters/trpc`: the browser bundle
carries none of the server's code.

## What the gates enforce

- `bounded-ts-trpc/router-type-reexported` — the client is typed by the
  router type the adapter re-exports, never a local alias or none.
- `bounded-ts-trpc/no-erased-router` — no `AnyRouter` or other erased type.
- `bounded-ts-trpc/raw-framework-entry` — the server entry serves the
  generated router through `@trpc/server/adapters/fetch`; no second
  `initTRPC`.
- ts-hexagonal's type-only rule for server code imported by `client/`.
- Delivery's `web-obligation`, for every web app the TNs declare: its
  server entry, composition root, client page and client entry exist, every
  client import resolves, and `main.tsx` uses a typed client. `check:build`
  bundles each declared app's client page with Bun, so an entry that does not
  resolve fails `check`. With no web app declared, both do nothing and say so.

## Testing

One smoke test per app, next to the composition root, against
`composeApp()` (lead decision Q2). The in-adapter level is generated laws;
nobody writes tests under `adapters/in/`.
