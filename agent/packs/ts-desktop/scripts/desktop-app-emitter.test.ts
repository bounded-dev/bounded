import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { workspaceTemplates } from "../../ts/pack.ts";
import { exampleFacts, manifestDifferences, readExample } from "../../example-suite/example-facts.ts";
import { emitDesktopApps } from "./desktop-app-emitter.ts";

// The app-template golden (WI-7): the desktop app seeded from the worked
// example's design is the example's apps/desktop, minus the main process's
// demo calls (the builder's), with the same composeApp() the web app has.

const APP = "apps/desktop/src";

describe("the desktop app of the worked example", () => {
  const emitted = emitDesktopApps(exampleFacts());
  const content = (path: string): string => emitted.find((f) => f.path === `${APP}/${path}`)!.content;

  test("seeds four skeleton files", () => {
    expect(emitted.map((f) => [f.path, f.mode])).toEqual([
      [`${APP}/main/composition-root.ts`, "skeleton"],
      [`${APP}/main/main.ts`, "skeleton"],
      [`${APP}/renderer/index.html`, "skeleton"],
      [`${APP}/renderer/main.tsx`, "skeleton"],
    ]);
  });

  test("the renderer is the example's, byte for byte", () => {
    expect(content("renderer/index.html")).toBe(readExample(`${APP}/renderer/index.html`));
    expect(content("renderer/main.tsx")).toBe(readExample(`${APP}/renderer/main.tsx`));
  });

  test("the main process hosts the router in-process and opens the window, as the example does", () => {
    const main = content("main/main.ts").split("\n");
    const example = readExample(`${APP}/main/main.ts`).split("\n");
    for (const line of [
      'import { app, BrowserWindow } from "electron";',
      'import path from "node:path";',
      'import { composeApp } from "./composition-root.ts";',
      "const api = composeApp().createCaller({});",
      "app.whenReady().then(async () => {",
      "  const window = new BrowserWindow({ width: 1000, height: 700 });",
      '  window.loadFile(path.join(__dirname, "../renderer/index.html"));',
      "});",
    ]) {
      expect(example, line).toContain(line);
      expect(main, line).toContain(line);
    }
    expect(readExample(`${APP}/main/composition-root.ts`)).toContain("export function composeApp() {");
    expect(content("main/composition-root.ts")).toContain("export function composeApp(): ProjectManagementRouter {");
  });

  test("the manifest template is the example's, pinned exactly", () => {
    const template = workspaceTemplates(["ts", "ts-hexagonal", "ts-trpc", "ts-web", "ts-desktop"]).find((t) => t.kind === "desktop")!;
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", template.manifest), "utf8"));
    expect(manifestDifferences(manifest, JSON.parse(readExample("apps/desktop/package.json")))).toEqual([]);
  });
});
