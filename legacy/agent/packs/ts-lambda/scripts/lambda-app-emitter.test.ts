import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { workspaceTemplates, type EmittedFile } from "../../ts/pack.ts";
import {
  EXAMPLE_CONTEXT,
  exampleContracts,
  exampleFacts,
  manifestDifferences,
  readExample,
} from "../../example-suite/example-facts.ts";
import { emitLambdaApps } from "./lambda-app-emitter.ts";

// The app-template golden (WI-7): the Lambda app seeded from the worked
// example's design is the example's apps/lambdas — one entry per Lambda, and
// a composition root with one compose<Feature>() per Lambda.

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const hasBun = spawnSync("bun", ["--version"]).status === 0;
if (!hasBun) console.warn("lambda-app-emitter: the bundling case is skipped — `bun` is not on PATH");

/** `{{entries}}` as TN-26-012 §10 defines it: the workspace's entry files,
 *  workspace-relative, sorted by code point, joined by single spaces. */
function renderEntries(text: string, workspace: string, files: readonly EmittedFile[]): string {
  const entries = files.filter((f) => f.entry === true && f.path.startsWith(`${workspace}/`))
    .map((f) => f.path.slice(workspace.length + 1)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return text.split("{{entries}}").join(entries.join(" "));
}

describe("the Lambda app of the worked example", () => {
  const emitted = emitLambdaApps(exampleFacts());

  test("seeds the entry, byte for byte, and generates composeExportProjects()", () => {
    expect(emitted.map((f) => [f.path, f.mode])).toEqual([
      ["apps/lambdas/src/composition-root.ts", "generated"],
      ["apps/lambdas/src/export-projects.ts", "skeleton"],
    ]);
    expect(emitted[1]!.content).toBe(readExample("apps/lambdas/src/export-projects.ts"));
    // The reference copy's composition root is the generated one: the
    // example's, with its dependencies grouped by area (ADR LEG-2026-067).
    expect(emitted[0]!.content).toBe(readExample("apps/lambdas/src/composition-root.ts"));
    expect(emitted[0]!.content).toContain([
      "export function composeExportProjects(): ReturnType<typeof createExportProjectsLambda> {",
      "  const db = new InMemoryDatabase();",
      "",
      "  return createExportProjectsLambda({",
      "    projects: {",
      "      export: new ExportProjectsHandler(new InMemoryExportProjectsStore(db), new ConsoleProjectExporter()),",
      "    },",
      "  });",
      "}",
    ].join("\n"));
  });

  test("the manifest template, with its entries rendered, is the example's", () => {
    const template = workspaceTemplates(["ts", "ts-hexagonal", "ts-lambda"]).find((t) => t.kind === "lambdas")!;
    const text = readFileSync(join(import.meta.dirname, "..", template.manifest), "utf8");
    expect(text).toContain('"build": "bun build {{entries}} --outdir dist --target node"');
    const manifest = JSON.parse(renderEntries(text, "apps/lambdas", emitted));
    const example = JSON.parse(readExample("apps/lambdas/package.json"));
    expect(manifest.scripts.build).toBe("bun build src/export-projects.ts --outdir dist --target node");
    expect(manifestDifferences(manifest, example)).toEqual([]);
  });

  test("only the Lambda entries are marked entries", () => {
    expect(emitted.filter((f) => f.entry === true).map((f) => f.path)).toEqual(["apps/lambdas/src/export-projects.ts"]);
  });

  test.skipIf(!hasBun)("the build bundles exactly the entries: no composition root and no test file reach dist", () => {
    const dir = mkdtempSync(join(tmpdir(), "lambda-build-"));
    dirs.push(dir);
    const app = join(dir, "apps", "lambdas");
    for (const file of emitted) {
      mkdirSync(dirname(join(dir, file.path)), { recursive: true });
      writeFileSync(join(dir, file.path), file.content);
    }
    // The bundle's question is which files are entries, not what the context
    // does: a stand-in composition root keeps the context packages out of it.
    writeFileSync(join(app, "src", "composition-root.ts"),
      "export function composeExportProjects() {\n  return async (): Promise<void> => {};\n}\n");
    writeFileSync(join(app, "src", "composition-root.test.ts"), "export {};\n");
    writeFileSync(join(app, "src", "export-projects.test.ts"), "export {};\n");
    const manifest = JSON.parse(renderEntries(readFileSync(join(import.meta.dirname, "..", "templates", "lambdas", "package.json"), "utf8"),
      "apps/lambdas", emitted));
    const run = spawnSync("sh", ["-c", manifest.scripts.build], { cwd: app, encoding: "utf8" });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(readdirSync(join(app, "dist")).sort()).toEqual(["export-projects.js"]);
  });

  test("two Lambdas get two entries and two compose functions", () => {
    const contracts = exampleContracts().map((c) => ({ ...c, source: c.source.replace("@exposedVia trpc mcp", "@exposedVia trpc mcp lambda") }));
    const files = emitLambdaApps(exampleFacts({ contracts }));
    expect(files.map((f) => f.path)).toEqual([
      "apps/lambdas/src/composition-root.ts",
      "apps/lambdas/src/create-project.ts",
      "apps/lambdas/src/export-projects.ts",
      "apps/lambdas/src/list-projects.ts",
    ]);
    const root = files[0]!.content;
    expect(root.match(/^export function compose\w+\(\)/gm)).toEqual([
      "export function composeCreateProject()",
      "export function composeExportProjects()",
      "export function composeListProjects()",
    ]);
    // Each builds only its own handler, with its own database.
    expect(root).toContain("  return createListProjectsLambda({\n    projects: {\n      list: new ListProjectsHandler(new InMemoryListProjectsStore(db)),\n");
    expect(root.match(/const db = new InMemoryDatabase\(\);/g)).toHaveLength(3);
  });

  test("refuses a Lambda app with nothing to host", () => {
    const contracts = exampleContracts().filter((c) => !c.path.includes(`${EXAMPLE_CONTEXT}/src/application/projects/export-projects/`));
    expect(() => emitLambdaApps(exampleFacts({ contracts }))).toThrow(/no feature is tagged @exposedVia lambda/);
  });
});
