// The desktop app's seed files (ADR LEG-2026-061, TN-26-012 §1), emitted for
// every workspace a TN declares with kind `desktop`. The composition root is
// generated (ADR LEG-2026-067); the rest are skeletons: written once, then the
// builder's.
//
//   src/main/composition-root.ts   composeApp(): <Context>Router, generated
//   src/main/main.ts               the Electron main process: the router in-process, one window
//   src/renderer/index.html        the page the window loads
//   src/renderer/main.tsx          its React root
//
// A desktop app hosts exactly one context's router, called in-process through
// `createCaller` — no server, no port — and logs the context's first
// input-less query at start, as the worked example's main process does. The
// main process is bundled for Node, so ts-lambda's `no-bun-api` holds there
// whenever that pack is composed.

import type { EmittedFile, Emitter, ProjectFacts } from "../../ts/pack.ts";
import { firstInputlessQuery, hostedTrpcContext, MOUNT, routerCompositionRoot } from "../../ts-trpc/scripts/router-host.ts";

export const DESKTOP_KIND = "desktop";

const skeleton = (path: string, lines: readonly string[]): EmittedFile => ({ path, content: `${lines.join("\n")}\n`, mode: "skeleton" });

/** The main process: the router in-process, used once, and one window. */
function mainProcess(query: string | undefined): string[] {
  return [
    'import { app, BrowserWindow } from "electron";',
    'import path from "node:path";',
    'import { composeApp } from "./composition-root.ts";',
    "",
    "// The main process calls the context's API in-process: no server, no port.",
    `${query === undefined ? "export " : ""}const api = composeApp().createCaller({});`,
    "",
    "app.whenReady().then(async () => {",
    ...(query === undefined ? [] : [`  console.log(await api.${query}());`, ""]),
    "  const window = new BrowserWindow({ width: 1000, height: 700 });",
    '  window.loadFile(path.join(__dirname, "../renderer/index.html"));',
    "});",
  ];
}

export function emitDesktopApps(facts: ProjectFacts): EmittedFile[] {
  const out: EmittedFile[] = [];
  for (const app of facts.workspaces.filter((w) => w.kind === DESKTOP_KIND)) {
    const context = hostedTrpcContext(facts, app);
    const src = app.sourceRoot;
    out.push(
      routerCompositionRoot(facts, app, `${src}/main/composition-root.ts`, context),
      skeleton(`${src}/main/main.ts`, mainProcess(firstInputlessQuery(facts, context))),
      skeleton(`${src}/renderer/index.html`, [
        "<!doctype html>",
        "<html>",
        "  <body>",
        '    <div id="root"></div>',
        '    <script type="module" src="./main.tsx"></script>',
        "  </body>",
        "</html>",
      ]),
      skeleton(`${src}/renderer/main.tsx`, [
        'import { createRoot } from "react-dom/client";',
        "",
        ...MOUNT,
        "createRoot(root).render(<h1>Hello</h1>);",
      ]),
    );
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export const desktopAppEmitter: Emitter = {
  name: "desktop-app",
  description:
    "The seed files of every desktop app a TN declares: an Electron main process calling the context's tRPC router " +
    "in-process, its React renderer, and the generated composeApp().",
  emit: emitDesktopApps,
};
