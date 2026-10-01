// The drivers each app's composition root constructs (ADR 2026-061, appPins).
//
// A context's manifest pins drizzle-orm and pg, but Bun's isolated install
// hides from an app every package the app's own manifest does not declare. So
// an app whose composition root builds the context's DrizzleDatabase needs
// the driver for its runtime in its own manifest: drizzle-orm for
// `drizzle-orm/bun-sql` on Bun (web, MCP), and drizzle-orm, pg and @types/pg
// for `drizzle-orm/node-postgres` on Node (Lambdas, the Electron main
// process).
//
// The test generates the whole default stack's manifests for a design with a
// store and all four apps, checks each app's pins, then (with bun) writes a
// composition root per app kind, installs for real and type-checks with
// `bunx tsc`. A Bun app importing `pg` must still fail: the isolation the
// pins answer is real. Skipped, with the reason logged, only when bun is not
// on PATH; it needs the pinned packages from bun's cache or the registry.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { writeProjectPacks } from "../../src/project-composition.ts";
import {
  configFiles,
  generatedManifests,
  LOCKFILE,
  lockfileFor,
  type Manifest,
  manifestPath,
  serializeManifest,
  TSCONFIG,
  tsconfigFor,
} from "../ts/scripts/project-package.ts";

const PACKS_DIR = join(import.meta.dirname, "..");
const STACK = (JSON.parse(readFileSync(join(PACKS_DIR, "default-stack.json"), "utf8")) as { packs: string[] }).packs;
const NAME = "stack";
const CONTEXT = "contexts/notebook";
const DRIZZLE = (JSON.parse(readFileSync(join(import.meta.dirname, "contrib.json"), "utf8")) as {
  adapterTechnologies: { pins: { dependencies: Record<string, string>; devDependencies: Record<string, string> } }[];
}).adapterTechnologies[0]!.pins;

const HAS_BUN = spawnSync("bun", ["--version"]).status === 0;
if (!HAS_BUN) console.warn("app-drivers.test.ts: skipping the real install and type check — `bun` is not on PATH");

const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A project with the default stack, one context whose feature has a store,
 *  and the four apps declared in a TN. */
function stackProject(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "app-drivers-")), NAME);
  temporary.push(dirname(dir));
  mkdirSync(dir);
  writeProjectPacks(dir, STACK);
  write(dir, `${CONTEXT}/src/application/notes/list-notes/list-notes.contract.ts`, [
    "/**",
    " * List the notes",
    " * @exposedVia trpc mcp lambda",
    " */",
    "export interface ListNotes {",
    "  execute(): Promise<void>;",
    "}",
    "",
    "export interface ListNotesStore {",
    "  findAll(): Promise<void>;",
    "}",
    "",
  ].join("\n"));
  write(dir, `${CONTEXT}/src/application/index.ts`,
    'export type { ListNotes, ListNotesStore } from "./notes/list-notes/list-notes.contract.ts";\n');
  write(dir, "docs/tn/TN-1.md", [
    "---",
    "workspaces:",
    "  apps/web: web",
    "  apps/mcp: mcp",
    "  apps/lambdas: lambdas",
    "  apps/desktop: desktop",
    "---",
    "",
    "# TN-1",
    "",
  ].join("\n"));
  return dir;
}

const bunRoot = (driverImport: string) => [
  'import { SQL } from "bun";',
  `import { drizzle } from "${driverImport}";`,
  `import type { ListNotesStore } from "@${NAME}/notebook/application";`,
  "",
  "export const database = (url: string) => drizzle({ client: new SQL(url) });",
  "export type Store = ListNotesStore;",
  "",
].join("\n");

const nodeRoot = [
  'import { drizzle } from "drizzle-orm/node-postgres";',
  'import { Pool } from "pg";',
  `import type { ListNotesStore } from "@${NAME}/notebook/application";`,
  "",
  "export const database = (url: string) => drizzle({ client: new Pool({ connectionString: url }) });",
  "export type Store = ListNotesStore;",
  "",
].join("\n");

/** Each app kind's composition root, where its template puts it. */
const COMPOSITION_ROOTS: Readonly<Record<string, string>> = {
  "apps/web/src/server/composition-root.ts": bunRoot("drizzle-orm/bun-sql"),
  "apps/mcp/src/composition-root.ts": bunRoot("drizzle-orm/bun-sql"),
  "apps/lambdas/src/composition-root.ts": nodeRoot,
  "apps/desktop/src/main/composition-root.ts": nodeRoot,
};

describe("every app gets the Postgres driver its runtime needs", () => {
  const project = stackProject();
  const generated = generatedManifests(project, STACK, PACKS_DIR, NAME);
  const deps = (dir: string, section: "dependencies" | "devDependencies") =>
    (generated.manifests.get(dir)?.[section] ?? {}) as Record<string, string>;

  test("Bun apps take drizzle-orm; Node apps take drizzle-orm, pg and @types/pg; at the context's versions", () => {
    expect([...generated.manifests.keys()].sort()).toEqual(["", "apps/desktop", "apps/lambdas", "apps/mcp", "apps/web", CONTEXT]);
    const orm = DRIZZLE.dependencies["drizzle-orm"]!;
    expect(deps(CONTEXT, "dependencies")["drizzle-orm"]).toBe(orm);
    for (const app of ["apps/web", "apps/mcp"]) {
      expect(deps(app, "dependencies")["drizzle-orm"], app).toBe(orm);
      expect(deps(app, "dependencies"), app).not.toHaveProperty("pg");
    }
    for (const app of ["apps/lambdas", "apps/desktop"]) {
      expect(deps(app, "dependencies"), app).toMatchObject({ "drizzle-orm": orm, pg: DRIZZLE.dependencies["pg"]! });
      expect(deps(app, "devDependencies")["@types/pg"], app).toBe(DRIZZLE.devDependencies["@types/pg"]);
    }
  });

  test.skipIf(!HAS_BUN)("a composition root per app kind type-checks after a real install; an undeclared driver does not", { timeout: 600_000 }, () => {
    const files = new Map<string, string>();
    for (const [dir, manifest] of generated.manifests) files.set(manifestPath(dir), serializeManifest(manifest as Manifest));
    files.set(TSCONFIG, tsconfigFor(STACK, PACKS_DIR));
    files.set(LOCKFILE, lockfileFor(generated.manifests, undefined).lock);
    for (const [path, content] of configFiles(STACK, PACKS_DIR, NAME)) files.set(path, content);
    for (const [path, content] of Object.entries(COMPOSITION_ROOTS)) files.set(path, content);
    // A Bun app reaching for the Node driver it does not declare.
    files.set("apps/web/src/server/undeclared.ts", 'import { Pool } from "pg";\n\nexport const pool = new Pool();\n');
    for (const [path, content] of files) write(project, path, content);

    const install = spawnSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: project, encoding: "utf8", timeout: 300_000 });
    expect(install.status, install.stderr).toBe(0);
    const tsc = spawnSync("bunx", ["tsc", "-p", TSCONFIG], { cwd: project, encoding: "utf8", timeout: 300_000 });
    const errors = `${tsc.stdout}${tsc.stderr}`.split("\n").filter((line) => line.includes("error TS"));
    expect(errors).toEqual([expect.stringMatching(/^apps\/web\/src\/server\/undeclared\.ts\(1,\d+\): error TS2307: Cannot find module 'pg'/)]);
  });
});
