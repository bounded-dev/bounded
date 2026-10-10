import { describe, expect, test } from "bun:test";
import { demoPackage } from "../../../application/catalog/build-package-catalog/build-package-catalog.demo-package.test-support.ts";
import { ADD_A_DEFAULT_CONDITION, packModulesConformance } from "../../../application/catalog/build-package-catalog/build-package-catalog.pack-modules.test-support.ts";
import { NodePackModules } from "./pack-modules.ts";

/** A copy of the demonstration package whose ./demo export entry is `demoExport`, or whose exports are `exports` (the fixture's when neither is given). */
const packageWith = (demoExport?: unknown, exports?: unknown, main?: string): Promise<string> => {
  if (main !== undefined) return demoPackage({ manifest: ({ exports: _exports, ...manifest }) => ({ ...manifest, main }) });
  const written = exports ?? (demoExport === undefined ? undefined : { "./demo": demoExport });
  return demoPackage(written === undefined ? {} : { manifest: (manifest) => ({ ...manifest, exports: written }) });
};

packModulesConformance("NodePackModules", async (demoExport, exports, main) => ({ modules: new NodePackModules(), packageDir: await packageWith(demoExport, exports, main) }));

describe("NodePackModules", () => {
  test("refuses a package root with neither exports, main nor index.js, saying to add main or exports", async () => {
    const packageDir = await demoPackage({ manifest: ({ exports: _exports, ...manifest }) => manifest });
    const loaded = await new NodePackModules().load(packageDir, ".");
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error).toContain("add main or exports");
  });

  test("refuses an import-only entry with the same message under Node as under the test runner's runtime", async () => {
    const packageDir = await packageWith({ import: "./dist/demo/index.js" });
    const here = await new NodePackModules().load(packageDir, "./demo");
    expect(here.ok).toBe(false);
    // bounded/adapters resolves, under Node, through the package's node_modules/bounded to bounded's dist/.
    const script = `const { NodePackModules } = await import("bounded/adapters"); const loaded = await new NodePackModules().load(${JSON.stringify(packageDir)}, "./demo"); console.log(JSON.stringify(loaded));`;
    const ran = Bun.spawnSync(["node", "--input-type=module", "-e", script], { cwd: packageDir, stdout: "pipe", stderr: "pipe" });
    expect(ran.stderr.toString()).toBe("");
    const underNode: unknown = JSON.parse(ran.stdout.toString());
    expect(underNode).toEqual(here);
    expect(!here.ok && here.error).toContain(ADD_A_DEFAULT_CONDITION);
  });
});
