import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, test } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { appDirOf, buildsForNode, noBunApi } from "./no-bun-api.ts";

// ADR LEG-2026-062: an app bundled with `bun build --target node` runs on Node
// (the Lambda runtime), so a Bun API in it throws only in production. The
// scope is read from the app's own manifest, so the fixtures are real trees.

const root = mkdtempSync(join(tmpdir(), "no-bun-api-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function app(name: string, build: string | undefined): string {
  const dir = join(root, "apps", name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: build === undefined ? {} : { build } }));
  return join(dir, "src", "export-projects.ts");
}

const LAMBDA = app("lambdas", "bun build ./src/*.ts --outdir dist --target node");
const DESKTOP = app("desktop", "bun build src/main/main.ts --outdir dist/main --target node --format cjs");
const WEB = app("web", undefined);

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester().run("no-bun-api", noBunApi, {
  valid: [
    // THE WORKED EXAMPLE's apps/lambdas/src/export-projects.ts.
    {
      code: `import { composeExportProjects } from "./composition-root.ts";\nexport const handler = composeExportProjects();`,
      filename: LAMBDA,
    },
    // Node and web-standard APIs are the remedy.
    { code: `import { readFileSync } from "node:fs";\nexport const id = crypto.randomUUID(); export const url = import.meta.url;`, filename: LAMBDA },
    // Types are erased.
    { code: `import type { Server } from "bun";\nexport type S = Server;`, filename: LAMBDA },
    // A local binding named Bun is not the global.
    { code: `const Bun = { file: (p: string) => p };\nexport const f = Bun.file("x");`, filename: LAMBDA },
    // An app that runs on Bun may use Bun.
    { code: `export const server = Bun.serve({ fetch: () => new Response("ok") });`, filename: WEB },
    // Not under apps/<app>/src/ at all.
    { code: `export const f = Bun.file("x");`, filename: join(root, "contexts", "pm", "src", "x.ts") },
  ],
  invalid: [
    { code: `export const f = Bun.file("x");`, filename: LAMBDA, errors: [{ messageId: "bunGlobal" }] },
    { code: `import { Database } from "bun:sqlite";`, filename: LAMBDA, errors: [{ messageId: "bunModule", data: { source: "bun:sqlite" } }] },
    { code: `import { $ } from "bun";`, filename: LAMBDA, errors: [{ messageId: "bunModule", data: { source: "bun" } }] },
    { code: `export const load = () => import("bun");`, filename: LAMBDA, errors: [{ messageId: "bunModule" }] },
    { code: `export const here = import.meta.dir;`, filename: LAMBDA, errors: [{ messageId: "bunMeta", data: { member: "dir" } }] },
    { code: `if (import.meta.main) console.log("x");`, filename: LAMBDA, errors: [{ messageId: "bunMeta", data: { member: "main" } }] },
    // An Electron main process is bundled for Node too.
    { code: `export const f = Bun.file("x");`, filename: DESKTOP, errors: [{ messageId: "bunGlobal" }] },
  ],
});

describe("scope", () => {
  test("the app directory is read from the path", () => {
    expect(appDirOf("/p/apps/lambdas/src/a.ts")).toBe("/p/apps/lambdas");
    expect(appDirOf("apps/lambdas/src/nested/a.ts")).toBe("apps/lambdas");
    expect(appDirOf("/p/contexts/pm/src/a.ts")).toBeUndefined();
  });

  test("only a build script that targets node puts an app in scope", () => {
    expect(buildsForNode(join(root, "apps", "lambdas"))).toBe(true);
    expect(buildsForNode(join(root, "apps", "web"))).toBe(false);
    expect(buildsForNode(join(root, "apps", "missing"))).toBe(false);
    writeFileSync(join(root, "apps", "web", "package.json"), "{ not json");
    expect(buildsForNode(join(root, "apps", "web"))).toBe(false);
  });
});
