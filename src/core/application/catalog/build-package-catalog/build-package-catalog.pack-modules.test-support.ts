import { describe, expect, test } from "bun:test";
import type { PackModules } from "./build-package-catalog.contract.ts";

/** A copy of the demonstration package (demo-package, its pack built to dist/demo/index.js) and the PackModules under test. */
export interface PackModulesFixture {
  readonly modules: PackModules;
  readonly packageDir: string;
}

/** The fix a refusal of an export entry with no target Node's require would pick names. */
export const ADD_A_DEFAULT_CONDITION = "add a `default` condition";

/** The behaviour every PackModules must have; `fixture` is given the export entry for ./demo to write into the package's package.json, or none to keep the fixture's. */
export function packModulesConformance(name: string, fixture: (demoExport?: unknown) => Promise<PackModulesFixture>): void {
  describe(`${name} conforms to PackModules`, () => {
    test("loads demo-package/demo and reports its exports' names, demoPack among them", async () => {
      const given = await fixture();
      const loaded = await given.modules.load(given.packageDir, "./demo");
      expect(loaded.ok).toBe(true);
      expect(loaded.ok && loaded.value.map(({ name }) => name)).toContain("demoPack");
    });

    test("refuses an export path the package does not list, naming it", async () => {
      const given = await fixture();
      const loaded = await given.modules.load(given.packageDir, "./missing");
      expect(loaded.ok).toBe(false);
      expect(!loaded.ok && loaded.error).toContain("./missing");
    });

    test("refuses an import-only entry before resolving it, naming ./demo and the fix", async () => {
      const given = await fixture({ import: "./dist/demo/index.js" });
      const loaded = await given.modules.load(given.packageDir, "./demo");
      expect(loaded.ok).toBe(false);
      expect(!loaded.ok && loaded.error).toContain("./demo");
      expect(!loaded.ok && loaded.error).toContain(ADD_A_DEFAULT_CONDITION);
    });

    test("accepts a nested { node: { default } } entry", async () => {
      const given = await fixture({ node: { default: "./dist/demo/index.js" } });
      const loaded = await given.modules.load(given.packageDir, "./demo");
      expect(loaded.ok).toBe(true);
      expect(loaded.ok && loaded.value.map(({ name }) => name)).toContain("demoPack");
    });
  });
}
