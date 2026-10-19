// bounded's own catalogue (ADR 2026-029): `bounded catalog build`, the built
// CLI under bun, run in src/ as bounded's prepack runs it.
//
// This test writes the shared, gitignored src/bounded.catalog.json, as do
// src/core/composition-root/pack-wire-schemas.test.ts, src/test/packaging.test.ts
// and src/cli/test/bounded-cli.e2e.test.ts (both pack bounded, whose prepack
// builds it). They rely on `bun test` running test files one after another,
// and each test that reads the file rebuilds it first.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { BunPackModules } from "bounded/adapters";
import { ExampleScenarios } from "bounded/domain";

const BOUNDED_DIR = resolve(import.meta.dir, "..");

interface Entry {
  readonly id: string;
  readonly summary: string;
  readonly contributesTo: readonly string[];
  readonly points: readonly { readonly key: string; readonly wire: { readonly type: string } | null }[];
  readonly ports: readonly { readonly key: string; readonly declaration: string }[];
  readonly examples: readonly { readonly path: string; readonly source: string; readonly scenarios?: unknown }[];
}

/** bounded's catalogue, rebuilt now. */
function builtCatalogue(): { readonly status: number | null; readonly output: string; readonly catalogue: { readonly package?: { readonly version?: string }; readonly packs?: readonly Entry[] } } {
  const ran = spawnSync(process.execPath, [join(BOUNDED_DIR, "dist", "cli.js"), "catalog", "build"], { cwd: BOUNDED_DIR, encoding: "utf8" });
  const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  if (ran.status !== 0) return { status: ran.status, output, catalogue: {} };
  return { status: ran.status, output, catalogue: JSON.parse(readFileSync(join(BOUNDED_DIR, "bounded.catalog.json"), "utf8")) };
}
const built = builtCatalogue();
const entry = (id: string): Entry | undefined => built.catalogue.packs?.find((pack) => pack.id === id);

describe("bounded's own catalogue", () => {
  test("lists bounded/prereqs and bounded/protected-paths, at src/package.json's version", () => {
    expect({ status: built.status, output: built.output }).toEqual({ status: 0, output: expect.stringContaining("Wrote bounded.catalog.json") });
    expect(built.catalogue.packs?.map(({ id }) => id)).toEqual(["bounded/prereqs", "bounded/protected-paths"]);
    expect(built.catalogue.package?.version).toBe(JSON.parse(readFileSync(join(BOUNDED_DIR, "package.json"), "utf8")).version);
  });

  test("prereqs: its lifecycle contributions, its rules point, its two ports and its summary", () => {
    const prereqs = entry("bounded/prereqs");
    expect(prereqs?.contributesTo).toEqual(["bounded/core.beforeTool", "bounded/core.afterTool", "bounded/core.onAgentRunFinish"]);
    expect(prereqs?.points.map(({ key, wire }) => ({ key, wire: wire?.type }))).toEqual([{ key: "rules", wire: "PrerequisiteRuleJSON" }]);
    expect(prereqs?.ports.map(({ key }) => key)).toEqual(["fileSetFingerprints", "prerequisiteRecords"]);
    expect(prereqs?.ports[0]?.declaration).toContain("fingerprint(");
    expect(prereqs?.summary).toBe("an action needs a prerequisite");
  });

  test("prereqs: its optional port, the status snapshots, apart from its two ports; protected-paths has none", () => {
    const prereqs = entry("bounded/prereqs") as (Entry & { readonly optionalPorts?: readonly { readonly id: string; readonly key: string; readonly adapterType: string }[] }) | undefined;
    expect(prereqs?.ports.map(({ key }) => key)).toEqual(["fileSetFingerprints", "prerequisiteRecords"]);
    expect(prereqs?.optionalPorts?.map(({ id, key, adapterType }) => ({ id, key, adapterType }))).toEqual([{ id: "bounded/prereqs#prerequisiteStatusSnapshots", key: "prerequisiteStatusSnapshots", adapterType: "PrerequisiteStatusSnapshots" }]);
    expect((entry("bounded/protected-paths") as { readonly optionalPorts?: unknown } | undefined)?.optionalPorts).toBeUndefined();
  });

  test("protected-paths: its guards, then its lifecycle contributions, its protectedPaths point and its two ports", () => {
    const protectedPaths = entry("bounded/protected-paths");
    expect(protectedPaths?.contributesTo).toEqual([
      "bounded/core.effectGuards.read",
      "bounded/core.effectGuards.list",
      "bounded/core.effectGuards.write",
      "bounded/core.effectGuards.execute",
      "bounded/core.beforeTool",
      "bounded/core.afterTool",
    ]);
    expect(protectedPaths?.points.map(({ key, wire }) => ({ key, wire: wire?.type }))).toEqual([{ key: "protectedPaths", wire: "ProtectedPathJSON" }]);
    expect(protectedPaths?.ports.map(({ key }) => key)).toEqual(["watchedFiles", "shellSnapshots"]);
  });

  test("every example file is embedded verbatim", () => {
    const examplePaths = [...new Glob("packs/*/examples/*.config.ts").scanSync({ cwd: BOUNDED_DIR })].sort();
    expect(examplePaths.length).toBeGreaterThan(0);
    const embedded = (built.catalogue.packs ?? []).flatMap((pack) => pack.examples);
    expect(embedded.map(({ path }) => path).sort()).toEqual(examplePaths);
    for (const example of embedded) expect({ path: example.path, verbatim: example.source === readFileSync(join(BOUNDED_DIR, example.path), "utf8") }).toEqual({ path: example.path, verbatim: true });
  });

  test("every example's scenarios are in the catalogue, in their normal form", async () => {
    const embedded = (built.catalogue.packs ?? []).flatMap((pack) => pack.examples);
    expect(embedded.length).toBeGreaterThan(0);
    for (const example of embedded) {
      const scenariosPath = example.path.replace(/\.config\.ts$/, ".scenarios.ts");
      const loaded = await new BunPackModules().loadDefaultExport(BOUNDED_DIR, scenariosPath);
      const fromFile = loaded.ok ? ExampleScenarios.parse(loaded.value) : loaded;
      expect({ path: scenariosPath, parsed: fromFile.ok ? "parsed" : fromFile.error }).toEqual({ path: scenariosPath, parsed: "parsed" });
      if (!fromFile.ok) continue;
      expect({ path: example.path, scenarios: example.scenarios }).toEqual({ path: example.path, scenarios: fromFile.value.toJSON().scenarios });
      const catalogued = ExampleScenarios.parse({ scenarios: example.scenarios });
      expect<unknown>({ path: example.path, normal: catalogued.ok ? catalogued.value.toJSON().scenarios : catalogued.error }).toEqual({ path: example.path, normal: example.scenarios });
      expect({ path: example.path, scenarios: Array.isArray(example.scenarios) && example.scenarios.length > 0 }).toEqual({ path: example.path, scenarios: true });
    }
  });
});
