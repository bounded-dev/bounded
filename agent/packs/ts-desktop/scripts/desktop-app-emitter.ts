// The desktop app's seed files (ADR 2026-061, TN-26-012 §1), emitted for
// every workspace a TN declares with kind `desktop`. All are skeletons:
// written once, then the builder's.
//
//   src/main/composition-root.ts   composeApp(): <Context>Router, wired by the builder
//   src/main/main.ts               the Electron main process: the router in-process, one window
//   src/renderer/index.html        the page the window loads
//   src/renderer/main.tsx          its React root
//
// A desktop app hosts exactly one context's router, called in-process through
// `createCaller` — no server, no port. The main process is bundled for Node,
// so `no-bun-api` (ts-lambda) would apply if composed; this pack does not
// depend on it, so the manifest's `--target node` is the whole contract.

import type { EmittedFile, Emitter, ProjectFacts } from "../../ts/pack.ts";
import { hostedTrpcContext, routerCompositionRoot } from "../../ts-web/scripts/web-app-emitter.ts";

export const DESKTOP_KIND = "desktop";

const skeleton = (path: string, lines: readonly string[]): EmittedFile => ({ path, content: `${lines.join("\n")}\n`, mode: "skeleton" });

export function emitDesktopApps(facts: ProjectFacts): EmittedFile[] {
  const out: EmittedFile[] = [];
  for (const app of facts.workspaces.filter((w) => w.kind === DESKTOP_KIND)) {
    const context = hostedTrpcContext(facts, app);
    const src = app.sourceRoot;
    out.push(
      routerCompositionRoot(`${src}/main/composition-root.ts`, facts.scope, context),
      skeleton(`${src}/main/main.ts`, [
        'import { app, BrowserWindow } from "electron";',
        'import path from "node:path";',
        'import { composeApp } from "./composition-root.ts";',
        "",
        "// The main process calls the context's API in-process: no server, no port.",
        "const api = composeApp().createCaller({});",
        "",
        "app.whenReady().then(async () => {",
        "  const window = new BrowserWindow({ width: 1000, height: 700 });",
        '  window.loadFile(path.join(__dirname, "../renderer/index.html"));',
        "});",
      ]),
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
        'createRoot(document.getElementById("root")!).render(<h1>Hello</h1>);',
      ]),
    );
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export const desktopAppEmitter: Emitter = {
  name: "desktop-app",
  description:
    "The seed files of every desktop app a TN declares: an Electron main process calling the context's tRPC router " +
    "in-process, its React renderer, and the composeApp() skeleton.",
  emit: emitDesktopApps,
};
