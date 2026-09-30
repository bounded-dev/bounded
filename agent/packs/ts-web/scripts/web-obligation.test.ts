import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { exampleFacts } from "../../example-suite/example-facts.ts";
import { emitWebApps } from "./web-app-emitter.ts";
import { runWebObligation } from "./web-obligation.ts";
import { declaredWorkspaces } from "./web-build-check.ts";

// ts-web's delivery obligation acts on the web apps the design declares, and
// only on those: a project with ts-web composed and no web app declared (a
// desktop-only project, say) has nothing to check. For a declared web app it
// blocks a client that does not bundle (dogfood Run 29) and a client that does
// not reach the service through a typed, used tRPC client.

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "web-obligation-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const tn = (entries: string): string => `---\nissue: 7\nstatus: active\nworkspaces:\n${entries}---\n\n# Apps\n`;
const DECLARED = { "docs/tn/TN-7.md": tn("  apps/web: web\n") };
/** The seeded web app of the worked example: a whole, typed, used door. */
const SEEDED = Object.fromEntries(emitWebApps(exampleFacts()).map((f) => [f.path, f.content]));
const MAIN = "apps/web/src/client/main.tsx";

describe("which apps it checks", () => {
  test("none declared: it passes, saying it checked nothing", () => {
    expect(runWebObligation(project({}))).toEqual({
      verdict: "pass", summary: "ts-web: no web app is declared (TN workspaces) — nothing to check",
    });
  });

  test("a desktop-only design is not a web project, even with apps on disk", () => {
    const desktop = project({
      "docs/tn/TN-7.md": tn("  apps/desktop: desktop\n"),
      "apps/desktop/src/renderer/index.html": "<!doctype html>\n",
    });
    expect(runWebObligation(desktop).verdict).toBe("pass");
  });

  test("the TN maps are read strictly and merged", () => {
    const dir = project({
      "docs/tn/TN-7.md": tn("  apps/web: web\n  apps/mcp: mcp\n"),
      "docs/tn/TN-8.md": tn("  apps/web: web\n"),
      "docs/tn/README.md": "No front matter here.\n",
    });
    expect([...declaredWorkspaces(dir)]).toEqual([["apps/mcp", "mcp"], ["apps/web", "web"]]);
    const clash = project({ "docs/tn/TN-7.md": tn("  apps/web: web\n"), "docs/tn/TN-8.md": tn("  apps/web: desktop\n") });
    expect(runWebObligation(clash)).toMatchObject({ verdict: "block", summary: expect.stringMatching(/declared as both web and desktop/) });
    const malformed = project({ "docs/tn/TN-7.md": tn("   apps/web: web\n") });
    expect(runWebObligation(malformed).verdict).toBe("block");
  });
});

describe("a declared web app", () => {
  test("the seeded app passes", () => {
    expect(runWebObligation(project({ ...DECLARED, ...SEEDED }))).toEqual({
      verdict: "pass", summary: "ts-web: apps/web serve a bundling client typed by the hosted router",
    });
  });

  test("declared but not there is a block naming every missing file", () => {
    const r = runWebObligation(project(DECLARED));
    expect(r.verdict).toBe("block");
    expect(r.detail).toEqual([
      "apps/web/src/client/index.html is missing", "apps/web/src/client/main.tsx is missing",
      "apps/web/src/server/main.ts is missing", "apps/web/src/server/composition-root.ts is missing",
    ]);
  });

  // Dogfood Run 29: green and delivered, but main imported a module nobody wrote.
  test("a client import that resolves to nothing is a block (Run 29)", () => {
    const main = SEEDED[MAIN]!.replace('import { createRoot } from "react-dom/client";', 'import { createRoot } from "react-dom/client";\nimport { Page } from "./app.tsx";');
    const r = runWebObligation(project({ ...DECLARED, ...SEEDED, [MAIN]: main }));
    expect(r.verdict).toBe("block");
    expect(r.detail).toEqual([`${MAIN}: "./app.tsx" does not resolve`]);
    // Written, it resolves, and so does what it imports in turn.
    const whole = { ...DECLARED, ...SEEDED, [MAIN]: main, "apps/web/src/client/app.tsx": 'import "./missing.ts";\nexport const Page = 1;\n' };
    expect(runWebObligation(project(whole)).detail).toEqual([`apps/web/src/client/app.tsx: "./missing.ts" does not resolve`]);
  });

  test("a page whose script does not resolve is a block", () => {
    const page = "apps/web/src/client/index.html";
    const r = runWebObligation(project({ ...DECLARED, ...SEEDED, [page]: SEEDED[page]!.replace("./main.tsx", "./index.tsx") }));
    expect(r.detail).toEqual([`${page}: script "./index.tsx" does not resolve`]);
  });

  test("the client must reach the service: a typed client, and used", () => {
    const untyped = SEEDED[MAIN]!.replace("createTRPCClient<ProjectManagementRouter>", "createTRPCClient<any>");
    expect(runWebObligation(project({ ...DECLARED, ...SEEDED, [MAIN]: untyped })).detail)
      .toEqual([`${MAIN}: creates no tRPC client typed by a router type imported type-only from a context's ./adapters/trpc`]);
    const unused = SEEDED[MAIN]!.replace("    api.notes.list.query().then(setData);\n", "");
    expect(runWebObligation(project({ ...DECLARED, ...SEEDED, [MAIN]: unused.replace("typeof api.notes.list.query", "typeof fetch") })).detail)
      .toEqual([`${MAIN}: the typed client 'api' is never used`]);
  });
});
