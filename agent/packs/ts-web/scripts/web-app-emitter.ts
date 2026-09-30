// The web app's seed files (ADR 2026-061, TN-26-012 §1), emitted for every
// workspace a TN declares with kind `web`. All are skeletons: written once,
// then the builder's.
//
//   src/server/composition-root.ts   composeApp(): <Context>Router — the builder wires handlers and adapters
//   src/server/main.ts               Bun.serve: the client's HTML import at "/", the router at "/trpc/*"
//   src/client/index.html            the page, titled after the context
//   src/client/main.tsx              a React root with a tRPC client typed by the router's re-exported type
//
// The client imports the router TYPE only (`router-type-reexported`, and
// ts-hexagonal's client-type-only rule): the browser bundle carries none of
// the server's code. A web app hosts exactly one context's router; the context
// is the one whose features are exposed via tRPC.

import type { EmittedFile, Emitter, ProjectFacts, WorkspaceFacts } from "../../ts/pack.ts";
import { byContext, featuresExposedVia } from "../../ts-trpc/scripts/in-adapter-kit.ts";
import { contextRouterType, TRPC } from "../../ts-trpc/scripts/trpc-emitter.ts";

export const WEB_KIND = "web";

/** The one context a router-hosting app serves, or a refusal naming the fix. */
export function hostedTrpcContext(facts: ProjectFacts, app: WorkspaceFacts): string {
  const contexts = [...byContext(featuresExposedVia(facts, TRPC)).keys()];
  if (contexts.length !== 1) {
    throw new Error(`${app.dir} (${app.kind}) hosts one context's tRPC router, but ${contexts.length === 0
      ? "no feature is tagged @exposedVia trpc"
      : `${contexts.length} contexts expose features via trpc (${contexts.join(", ")}); split them into one app each`}`);
  }
  return contexts[0]!;
}

/** "project-management" → "Project management". */
export function contextTitle(context: string): string {
  const words = context.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const skeleton = (path: string, lines: readonly string[]): EmittedFile => ({ path, content: `${lines.join("\n")}\n`, mode: "skeleton" });

/** `composeApp(): <Router>` — the router-hosting composition root skeleton. */
export function routerCompositionRoot(path: string, scope: string, context: string): EmittedFile {
  const router = contextRouterType(context);
  return skeleton(path, [
    `import type { ${router} } from "${scope}/${context}/adapters/trpc";`,
    "",
    "// The one place that decides which adapter backs which port.",
    `export function composeApp(): ${router} {`,
    '  throw new Error("Not implemented: composeApp");',
    "}",
  ]);
}

export function emitWebApps(facts: ProjectFacts): EmittedFile[] {
  const out: EmittedFile[] = [];
  for (const app of facts.workspaces.filter((w) => w.kind === WEB_KIND)) {
    const context = hostedTrpcContext(facts, app);
    const router = contextRouterType(context);
    const src = app.sourceRoot;
    out.push(
      skeleton(`${src}/client/index.html`, [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8" />',
        `    <title>${contextTitle(context)}</title>`,
        "  </head>",
        "  <body>",
        '    <div id="root"></div>',
        '    <script type="module" src="./main.tsx"></script>',
        "  </body>",
        "</html>",
      ]),
      skeleton(`${src}/client/main.tsx`, [
        'import { createTRPCClient, httpBatchLink } from "@trpc/client";',
        'import { createRoot } from "react-dom/client";',
        `import type { ${router} } from "${facts.scope}/${context}/adapters/trpc";`,
        "",
        "// Type-only import: the client gets the router's types, none of its server code.",
        `const api = createTRPCClient<${router}>({ links: [httpBatchLink({ url: "/trpc" })] });`,
        "",
        "function App() {",
        "  return (",
        "    <main>",
        `      <h1>${contextTitle(context)}</h1>`,
        "    </main>",
        "  );",
        "}",
        "",
        'createRoot(document.getElementById("root")!).render(<App />);',
      ]),
      routerCompositionRoot(`${src}/server/composition-root.ts`, facts.scope, context),
      skeleton(`${src}/server/main.ts`, [
        'import { fetchRequestHandler } from "@trpc/server/adapters/fetch";',
        'import index from "../client/index.html";',
        'import { composeApp } from "./composition-root.ts";',
        "",
        "const router = composeApp();",
        "",
        "const server = Bun.serve({",
        "  routes: {",
        '    "/": index,',
        '    "/trpc/*": (req) => fetchRequestHandler({ endpoint: "/trpc", req, router }),',
        "  },",
        "});",
        "",
        "console.log(`Listening on ${server.url}`);",
      ]),
    );
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export const webAppEmitter: Emitter = {
  name: "web-app",
  description:
    "The seed files of every web app a TN declares: a Bun.serve server hosting the context's tRPC router at /trpc/* " +
    "and its HTML page at /, a React client typed by the router's re-exported type, and the composeApp() skeleton.",
  emit: emitWebApps,
};
