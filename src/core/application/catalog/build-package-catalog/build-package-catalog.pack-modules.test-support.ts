import { describe, expect, test } from "bun:test";
import type { PackModules } from "./build-package-catalog.contract.ts";

/** A copy of the demonstration package (demo-package, its pack built to dist/demo/index.js) and the PackModules under test. */
export interface PackModulesFixture {
  readonly modules: PackModules;
  readonly packageDir: string;
}

/** The fix a refusal of an export entry with no target a host's import() under Node would pick names. */
export const ADD_A_DEFAULT_CONDITION = "add a `default` condition";
/** The fix a refusal of a target that does not exist names. */
export const BUILD_THE_PACKAGE_FIRST = "build the package first";

/**
 * The behaviour every PackModules must have; `fixture` is given the export entry for ./demo to write into the package's
 * package.json, or none to keep the fixture's, or, as `exports`, the whole of package.json's exports to write instead.
 */
export function packModulesConformance(name: string, fixture: (demoExport?: unknown, exports?: unknown, main?: string) => Promise<PackModulesFixture>): void {
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

    test("refuses a require-only entry, which a host's import() cannot reach, naming ./demo and the fix", async () => {
      const given = await fixture({ require: "./dist/demo/index.js" });
      const loaded = await given.modules.load(given.packageDir, "./demo");
      expect(loaded.ok).toBe(false);
      expect(!loaded.ok && loaded.error).toContain("./demo");
      expect(!loaded.ok && loaded.error).toContain(ADD_A_DEFAULT_CONDITION);
    });

    test("loads an import-only entry, as a host's import() does", async () => {
      const given = await fixture({ import: "./dist/demo/index.js" });
      const loaded = await given.modules.load(given.packageDir, "./demo");
      expect(loaded.ok ? "ok" : loaded.error).toBe("ok");
      expect(loaded.ok && loaded.value.map(({ name }) => name)).toContain("demoPack");
    });

    test("refuses a target that was never built, naming it and saying to build the package first", async () => {
      const given = await fixture({ default: "./dist/missing/index.js" });
      const loaded = await given.modules.load(given.packageDir, "./demo");
      expect(loaded.ok).toBe(false);
      expect(!loaded.ok && loaded.error).toContain("./dist/missing/index.js");
      expect(!loaded.ok && loaded.error).toContain(BUILD_THE_PACKAGE_FIRST);
    });

    test("refuses a target, and a main, outside the package, naming each", async () => {
      const throughExports = await fixture({ default: "../outside/index.js" });
      const exported = await throughExports.modules.load(throughExports.packageDir, "./demo");
      expect(exported.ok).toBe(false);
      expect(!exported.ok && exported.error).toContain("../outside/index.js");
      const throughMain = await fixture(undefined, undefined, "../outside/index.js");
      const main = await throughMain.modules.load(throughMain.packageDir, ".");
      expect(main.ok).toBe(false);
      expect(!main.ok && main.error).toContain("../outside/index.js");
      expect(!main.ok && main.error).toContain("not a file in the package");
    });

    test("loads a pack exported from the package root, `.`, whether exports is a path, a `.` entry or the root's conditions", async () => {
      for (const exports of ["./dist/demo/index.js", { ".": { default: "./dist/demo/index.js" } }, { default: "./dist/demo/index.js" }]) {
        const given = await fixture(undefined, exports);
        const loaded = await given.modules.load(given.packageDir, ".");
        expect({ exports, loaded: loaded.ok ? "ok" : loaded.error }).toEqual({ exports, loaded: "ok" });
        expect(loaded.ok && loaded.value.map(({ name }) => name)).toContain("demoPack");
      }
    });

    test("loads the package root through main when package.json has no exports, as Node does", async () => {
      const given = await fixture(undefined, undefined, "./dist/demo/index.js");
      const loaded = await given.modules.load(given.packageDir, ".");
      expect(loaded.ok ? "ok" : loaded.error).toBe("ok");
      expect(loaded.ok && loaded.value.map(({ name }) => name)).toContain("demoPack");
    });

    test("refuses a root export with only a require condition, naming `.` and the fix", async () => {
      const given = await fixture(undefined, { require: "./dist/demo/index.js" });
      const loaded = await given.modules.load(given.packageDir, ".");
      expect(loaded.ok).toBe(false);
      expect(!loaded.ok && loaded.error).toContain("export path .");
      expect(!loaded.ok && loaded.error).toContain(ADD_A_DEFAULT_CONDITION);
    });

    test("loads the default export of a package's module by its package-relative path", async () => {
      const given = await fixture();
      const loaded = await given.modules.loadDefaultExport(given.packageDir, "packs/demo/examples/basic.scenarios.ts");
      expect(loaded.ok ? "ok" : loaded.error).toBe("ok");
      expect(loaded.ok && loaded.value).toMatchObject({ scenarios: [expect.objectContaining({ title: expect.any(String), steps: expect.any(Array) })] });
    });

    test("refuses a path outside the package, naming it", async () => {
      const given = await fixture();
      for (const path of ["../outside.scenarios.ts", "/tmp/outside.scenarios.ts"]) {
        const loaded = await given.modules.loadDefaultExport(given.packageDir, path);
        expect({ path, ok: loaded.ok }).toEqual({ path, ok: false });
        expect(!loaded.ok && loaded.error).toContain(path);
      }
    });

    test("refuses a module with no default export, naming it", async () => {
      const given = await fixture();
      const loaded = await given.modules.loadDefaultExport(given.packageDir, "packs/demo/index.ts");
      expect(loaded.ok).toBe(false);
      expect(!loaded.ok && loaded.error).toContain("packs/demo/index.ts");
      expect(!loaded.ok && loaded.error).toContain("default export");
    });

    test("accepts a nested { node: { default } } entry", async () => {
      const given = await fixture({ node: { default: "./dist/demo/index.js" } });
      const loaded = await given.modules.load(given.packageDir, "./demo");
      expect(loaded.ok).toBe(true);
      expect(loaded.ok && loaded.value.map(({ name }) => name)).toContain("demoPack");
    });
  });
}
