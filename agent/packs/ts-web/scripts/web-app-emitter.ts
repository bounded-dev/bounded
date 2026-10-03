// The web app's seed files (ADR 2026-061, TN-26-012 §1), emitted for every
// workspace a TN declares with kind `web`. The composition root is generated
// (ADR 2026-066); the rest are skeletons: written once, then the builder's.
//
//   src/server/composition-root.ts   composeApp(): <Context>Router — generated: every handler and adapter, wired
//   src/server/main.ts               Bun.serve: the client's HTML import at "/", the router at "/trpc/*"
//   src/client/index.html            the page, titled after the context
//   src/client/main.tsx              a React root with a tRPC client typed by the router's re-exported type
//
// The client imports the router TYPE only (`router-type-reexported`, and
// ts-hexagonal's client-type-only rule): the browser bundle carries none of
// the server's code. It calls the context's first input-less query on mount,
// as the worked example's client does, so the typed door is exercised from
// the first run. A web app hosts exactly one context's router.

import type { EmittedFile, Emitter, ProjectFacts } from "../../ts/pack.ts";
import { contextTitle, firstInputlessQuery, hostedTrpcContext, MOUNT, routerCompositionRoot } from "../../ts-trpc/scripts/router-host.ts";
import { contextRouterType } from "../../ts-trpc/scripts/trpc-emitter.ts";

export const WEB_KIND = "web";

const skeleton = (path: string, lines: readonly string[]): EmittedFile => ({ path, content: `${lines.join("\n")}\n`, mode: "skeleton" });

/** The client entry: a typed client, used by the page. */
function clientMain(scope: string, context: string, query: string | undefined): string[] {
  const router = contextRouterType(context);
  const head = [
    'import { createTRPCClient, httpBatchLink } from "@trpc/client";',
    ...(query === undefined ? [] : ['import { useEffect, useState } from "react";']),
    'import { createRoot } from "react-dom/client";',
    `import type { ${router} } from "${scope}/${context}/adapters/trpc";`,
    "",
    "// Type-only import: the client gets the router's types, none of its server code.",
    `${query === undefined ? "export " : ""}const api = createTRPCClient<${router}>({ links: [httpBatchLink({ url: "/trpc" })] });`,
    "",
  ];
  const app = query === undefined
    ? [
      "// The context exposes no input-less query yet: the page calls `api` once it has one to show.",
      "function App() {",
      "  return (",
      "    <main>",
      `      <h1>${contextTitle(context)}</h1>`,
      "    </main>",
      "  );",
      "}",
    ]
    : [
      `type Data = Awaited<ReturnType<typeof api.${query}.query>>;`,
      "",
      "function App() {",
      "  const [data, setData] = useState<Data>();",
      "",
      "  useEffect(() => {",
      `    api.${query}.query().then(setData);`,
      "  }, []);",
      "",
      "  return (",
      "    <main>",
      `      <h1>${contextTitle(context)}</h1>`,
      "      <pre>{JSON.stringify(data, null, 2)}</pre>",
      "    </main>",
      "  );",
      "}",
    ];
  // No non-null assertion: the skeleton must pass the builder's own lint.
  return [...head, ...app, "", ...MOUNT, "createRoot(root).render(<App />);"];
}

export function emitWebApps(facts: ProjectFacts): EmittedFile[] {
  const out: EmittedFile[] = [];
  for (const app of facts.workspaces.filter((w) => w.kind === WEB_KIND)) {
    const context = hostedTrpcContext(facts, app);
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
      skeleton(`${src}/client/main.tsx`, clientMain(facts.scope, context, firstInputlessQuery(facts, context))),
      routerCompositionRoot(facts, app, `${src}/server/composition-root.ts`, context),
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
    "and its HTML page at /, a React client typed by the router's re-exported type, and the generated composeApp().",
  emit: emitWebApps,
};
