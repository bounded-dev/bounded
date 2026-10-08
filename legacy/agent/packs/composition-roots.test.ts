// The generated composition roots (ADR 2026-067, issue #44), golden.
//
// Two designs, every app kind (web, MCP, Lambda, desktop):
//
//   · the worked example (example-suite/reference/example): no storage pack,
//     so the in-memory stores, and its console exporter for the Lambda;
//   · the net-worth design of the 2026-10-03 dogfood
//     (example-suite/reference/net-worth: its contracts, rescoped to
//     `@dogfood`), with Postgres composed: `drizzle-orm/bun-sql` for the Bun
//     apps, `drizzle-orm/node-postgres` for the Node ones. Its TN declared a
//     web and an MCP app; the desktop and Lambda apps are added here, and
//     `list-workspaces` is also exposed via Lambda so the Lambda app has one.
//
// Each emitted composition root must equal its golden copy byte for byte.
// Then, with bun on PATH, each design becomes a whole project as the design
// gate scaffolds it (every emitter at red, the generated manifests, tsconfig
// and lockfile), installed for real with `bun install --frozen-lockfile`, and
// `bunx tsc` must report nothing: the composition roots type-check against
// the handlers, stores, adapters, in-adapter factories and drivers they name.
// Skipped, with the reason logged, only when bun is not on PATH.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { generatedFileGlobsFor, pathGlobMatcher } from "../src/pack-contrib.ts";
import { writeProjectPacks } from "../src/project-composition.ts";
import { emitProject, projectFactsOf } from "./ts/scripts/project-emitters.ts";
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
} from "./ts/scripts/project-package.ts";

const PACKS_DIR = import.meta.dirname;
const REFERENCE = join(PACKS_DIR, "example-suite", "reference");
const STACK = (JSON.parse(readFileSync(join(PACKS_DIR, "default-stack.json"), "utf8")) as { packs: string[] }).packs;
const WITHOUT_STORAGE = STACK.filter((p) => p !== "ts-drizzle-postgres");

const HAS_BUN = spawnSync("bun", ["--version"]).status === 0;
if (!HAS_BUN) console.warn("composition-roots.test.ts: skipping the real install and type check — `bun` is not on PATH");

const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

const ROOTS = [
  "apps/desktop/src/main/composition-root.ts",
  "apps/lambdas/src/composition-root.ts",
  "apps/mcp/src/composition-root.ts",
  "apps/web/src/server/composition-root.ts",
];

const TN = [
  "---",
  "workspaces:",
  "  apps/desktop: desktop",
  "  apps/lambdas: lambdas",
  "  apps/mcp: mcp",
  "  apps/web: web",
  "---",
  "",
  "# TN-1",
  "",
].join("\n");

interface Design {
  readonly label: string;
  /** The project name: its package scope is `@<name>`. */
  readonly name: string;
  readonly packs: readonly string[];
  /** The fixture directory holding `contexts/**` contracts and the golden `apps/**` roots. */
  readonly fixture: string;
  /** Another tree whose contracts replace the fixture's at the same path. */
  readonly overlay?: string;
  /** An edit to one contract, as `[path suffix, from, to]`. */
  readonly edit?: readonly [string, string, string];
}

const DESIGNS: readonly Design[] = [
  // The example's domain contracts carry no `@accepts` examples; the ts
  // pack's reference copy of them adds exactly those (TN-26-012 §4).
  {
    label: "the worked example", name: "example", packs: WITHOUT_STORAGE, fixture: join(REFERENCE, "example"),
    overlay: join(PACKS_DIR, "ts", "reference"),
  },
  {
    label: "the net-worth dogfood design", name: "dogfood", packs: STACK, fixture: join(REFERENCE, "net-worth"),
    edit: ["list-workspaces.contract.ts", "@exposedVia trpc mcp", "@exposedVia trpc mcp lambda"],
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A project holding only the design: its packs, its contracts and the TN. */
function designProject(design: Design): string {
  const dir = join(mkdtempSync(join(tmpdir(), "composition-roots-")), design.name);
  temporary.push(dirname(dir));
  mkdirSync(dir);
  writeProjectPacks(dir, design.packs);
  for (const root of [design.fixture, ...(design.overlay === undefined ? [] : [design.overlay])]) {
    for (const file of walk(join(root, "contexts")).filter((f) => f.endsWith(".contract.ts"))) {
      const path = relative(root, file).split("\\").join("/");
      let source = readFileSync(file, "utf8");
      if (design.edit !== undefined && path.endsWith(design.edit[0])) source = source.replace(design.edit[1], design.edit[2]);
      write(dir, path, source);
    }
  }
  write(dir, "docs/tn/TN-1.md", TN);
  const generated = generatedManifests(dir, design.packs, PACKS_DIR, design.name);
  write(dir, manifestPath(""), serializeManifest(generated.manifests.get("")! as Manifest));
  return dir;
}

describe.each(DESIGNS)("the composition roots of $label", (design) => {
  const project = designProject(design);
  const files = emitProject(projectFactsOf(project, "red", PACKS_DIR), generatedFileGlobsFor(design.packs, PACKS_DIR));
  const roots = files.filter((f) => f.path.endsWith("/composition-root.ts"));

  test("one per app, generated, write-protected, and equal to the golden copy byte for byte", () => {
    expect(roots.map((f) => f.path)).toEqual(ROOTS);
    const protectedPath = pathGlobMatcher(generatedFileGlobsFor(design.packs, PACKS_DIR));
    for (const root of roots) {
      expect(root.mode, root.path).toBe("generated");
      expect(protectedPath(root.path), root.path).toBe(true);
      expect(root.content, root.path).toBe(readFileSync(join(design.fixture, root.path), "utf8"));
    }
  });

  test("keeps the entry names the apps and their smoke tests call", () => {
    for (const root of roots.filter((f) => !f.path.includes("/lambdas/"))) {
      expect(root.content.match(/^export function \w+/gm), root.path).toEqual(["export function composeApp"]);
    }
    const lambdas = roots.find((f) => f.path.includes("/lambdas/"))!.content;
    const entries = files.filter((f) => f.entry === true).map((f) => f.path.replace(/^apps\/lambdas\/src\/(.*)\.ts$/, "$1"));
    expect(lambdas.match(/^export function \w+/gm)).toEqual(entries.map((e) => `export function compose${e.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")}`));
  });

  test.skipIf(!HAS_BUN)("type-check under `bunx tsc` after a real `bun install`", { timeout: 600_000 }, () => {
    // The emitted tree first: a context's manifest exports each adapter folder it holds.
    for (const file of files) write(project, file.path, file.content);
    const generated = generatedManifests(project, design.packs, PACKS_DIR, design.name);
    for (const [dir, manifest] of generated.manifests) write(project, manifestPath(dir), serializeManifest(manifest as Manifest));
    write(project, TSCONFIG, tsconfigFor(design.packs, PACKS_DIR));
    write(project, LOCKFILE, lockfileFor(generated.manifests, undefined).lock);
    for (const [path, content] of configFiles(design.packs, PACKS_DIR, design.name)) write(project, path, content);

    const install = spawnSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: project, encoding: "utf8", timeout: 300_000 });
    expect(install.status, install.stderr).toBe(0);
    const tsc = spawnSync("bunx", ["tsc", "-p", TSCONFIG], { cwd: project, encoding: "utf8", timeout: 300_000 });
    expect(`${tsc.stdout}${tsc.stderr}`.split("\n").filter((line) => line.includes("error TS"))).toEqual([]);
    expect(tsc.status).toBe(0);
  });
});
