import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runWebBuildCheck } from "./web-build-check.ts";

// The shipped check:build bundles the client of every web app the design
// declares, and nothing else. With none declared it succeeds and says so —
// the ts-web-composed project that has no web app must still pass `check`.

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const hasBun = spawnSync("bun", ["--version"]).status === 0;
if (!hasBun) console.warn("web-build-check: bundling cases skipped — `bun` is not on PATH");

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "web-build-check-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const TN = { "docs/tn/TN-7.md": "---\nworkspaces:\n  apps/web: web\n---\n" };
const PAGE = '<!doctype html>\n<html><body><script type="module" src="./main.tsx"></script></body></html>\n';

describe("check:build", () => {
  test("no web app declared: builds nothing, succeeds, and says so", () => {
    expect(runWebBuildCheck(project({}))).toEqual({ code: 0, lines: ["check:build: no web app is declared (TN workspaces) — nothing to build"] });
    const desktopOnly = project({ "docs/tn/TN-7.md": "---\nworkspaces:\n  apps/desktop: desktop\n---\n" });
    expect(runWebBuildCheck(desktopOnly).code).toBe(0);
  });

  test("a declared web app with no page fails", () => {
    expect(runWebBuildCheck(project(TN))).toEqual({
      code: 1, lines: ["check:build: apps/web is declared as a web app but has no apps/web/src/client/index.html"],
    });
  });

  test.skipIf(!hasBun)("a client that bundles passes; one importing a missing module fails (Run 29)", () => {
    const good = project({ ...TN, "apps/web/src/client/index.html": PAGE, "apps/web/src/client/main.tsx": "console.log(1 as number);\n" });
    expect(runWebBuildCheck(good)).toEqual({ code: 0, lines: ["check:build: apps/web bundles"] });
    const broken = project({
      ...TN, "apps/web/src/client/index.html": PAGE, "apps/web/src/client/main.tsx": 'import { App } from "./app.tsx";\nconsole.log(App);\n',
    });
    const r = runWebBuildCheck(broken);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toBe("check:build: apps/web does not bundle");
    expect(r.lines.join("\n")).toMatch(/app\.tsx/);
  });
});
