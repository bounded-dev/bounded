import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { workspaceTemplates } from "../../ts/pack.ts";
import {
  EXAMPLE_CONTEXT,
  exampleContracts,
  exampleFacts,
  manifestDifferences,
  readExample,
} from "../../ts-trpc/testing/example-facts.ts";
import { emitLambdaApps } from "./lambda-app-emitter.ts";

// The app-template golden (WI-7): the Lambda app seeded from the worked
// example's design is the example's apps/lambdas — one entry per Lambda, and
// a composition root with one compose<Feature>() per Lambda.

describe("the Lambda app of the worked example", () => {
  const emitted = emitLambdaApps(exampleFacts());

  test("seeds the entry, byte for byte, and the composeExportProjects() skeleton", () => {
    expect(emitted.map((f) => [f.path, f.mode])).toEqual([
      ["apps/lambdas/src/composition-root.ts", "skeleton"],
      ["apps/lambdas/src/export-projects.ts", "skeleton"],
    ]);
    expect(emitted[1]!.content).toBe(readExample("apps/lambdas/src/export-projects.ts"));
    expect(readExample("apps/lambdas/src/composition-root.ts")).toContain("export function composeExportProjects() {");
    expect(emitted[0]!.content).toBe([
      'import type { createExportProjectsLambda } from "@example/project-management/adapters/lambda";',
      "",
      "// The one place that decides which adapter backs which port. One function per Lambda.",
      "export function composeExportProjects(): ReturnType<typeof createExportProjectsLambda> {",
      '  throw new Error("Not implemented: composeExportProjects");',
      "}",
      "",
    ].join("\n"));
  });

  test("the manifest template is the example's, except that the build bundles every entry", () => {
    const template = workspaceTemplates(["ts", "ts-hexagonal", "ts-lambda"]).find((t) => t.kind === "lambdas")!;
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", template.manifest), "utf8"));
    const example = JSON.parse(readExample("apps/lambdas/package.json"));
    // A template is static text, so it cannot name the design's Lambdas: it
    // bundles every src/*.ts for Node instead of the example's one entry.
    expect(example.scripts.build).toBe("bun build src/export-projects.ts --outdir dist --target node");
    expect(manifest.scripts.build).toBe("bun build ./src/*.ts --outdir dist --target node");
    expect(manifestDifferences({ ...manifest, scripts: example.scripts }, example)).toEqual([]);
  });

  test("two Lambdas get two entries and two compose functions", () => {
    const contracts = exampleContracts().map((c) => ({ ...c, source: c.source.replace("@exposedVia trpc mcp", "@exposedVia trpc mcp lambda") }));
    const paths = emitLambdaApps(exampleFacts({ contracts })).map((f) => f.path);
    expect(paths).toEqual([
      "apps/lambdas/src/composition-root.ts",
      "apps/lambdas/src/create-project.ts",
      "apps/lambdas/src/export-projects.ts",
      "apps/lambdas/src/list-projects.ts",
    ]);
  });

  test("refuses a Lambda app with nothing to host", () => {
    const contracts = exampleContracts().filter((c) => !c.path.includes(`${EXAMPLE_CONTEXT}/src/application/projects/export-projects/`));
    expect(() => emitLambdaApps(exampleFacts({ contracts }))).toThrow(/no feature is tagged @exposedVia lambda/);
  });
});
