import { describe, expect, test } from "bun:test";
import { demoPackage } from "../../../application/catalog/build-package-catalog/build-package-catalog.demo-package.test-support.ts";
import { packModulesConformance } from "../../../application/catalog/build-package-catalog/build-package-catalog.pack-modules.test-support.ts";
import { BunPackModules } from "./pack-modules.ts";

/** A copy of the demonstration package whose ./demo export entry is `demoExport`, or whose exports are `exports` (the fixture's when neither is given). */
const packageWith = (demoExport?: unknown, exports?: unknown, main?: string): Promise<string> => {
  if (main !== undefined) return demoPackage({ manifest: ({ exports: _exports, ...manifest }) => ({ ...manifest, main }) });
  const written = exports ?? (demoExport === undefined ? undefined : { "./demo": demoExport });
  return demoPackage(written === undefined ? {} : { manifest: (manifest) => ({ ...manifest, exports: written }) });
};

packModulesConformance("BunPackModules", async (demoExport, exports, main) => ({ modules: new BunPackModules(), packageDir: await packageWith(demoExport, exports, main) }));

describe("BunPackModules", () => {
  test("refuses a package root with neither exports, main nor index.js, saying to add main or exports", async () => {
    const packageDir = await demoPackage({ manifest: ({ exports: _exports, ...manifest }) => manifest });
    const loaded = await new BunPackModules().load(packageDir, ".");
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error).toContain("add main or exports");
  });

  test("refuses to load under Node, saying to run the catalogue build under bun", async () => {
    const packageDir = await demoPackage();
    // bounded/adapters resolves, under Node, through the package's node_modules/bounded to bounded's dist/.
    const script = [
      `const { BunPackModules } = await import("bounded/adapters");`,
      `const load = await new BunPackModules().load(${JSON.stringify(packageDir)}, "./demo");`,
      `const loadDefaultExport = await new BunPackModules().loadDefaultExport(${JSON.stringify(packageDir)}, "packs/demo/examples/basic.scenarios.ts");`,
      "console.log(JSON.stringify({ load, loadDefaultExport }));",
    ].join(" ");
    const ran = Bun.spawnSync(["node", "--input-type=module", "-e", script], { cwd: packageDir, stdout: "pipe", stderr: "pipe" });
    expect(ran.stderr.toString()).toBe("");
    const underNode = JSON.parse(ran.stdout.toString()) as { load: { ok: boolean; error?: string }; loadDefaultExport: { ok: boolean; error?: string } };
    expect(underNode.load.ok).toBe(false);
    expect(underNode.load.error).toContain("under bun");
    expect(underNode.loadDefaultExport.ok).toBe(false);
    expect(underNode.loadDefaultExport.error).toContain("under bun");
  });

  test("refuses an import-only entry, saying to add a default condition, in full", async () => {
    const packageDir = await packageWith({ import: "./dist/demo/index.js" });
    const loaded = await new BunPackModules().load(packageDir, "./demo");
    expect(loaded).toEqual({
      ok: false,
      error: "demo-package's export path ./demo has no target Node's require picks (default, require or node): add a `default` condition naming its JavaScript, which hosts load under Node and the catalogue build loads too",
    });
  });
});
