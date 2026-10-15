import { describe, expect, test } from "bun:test";
import type { PackageCatalogFiles } from "./build-package-catalog.contract.ts";

/** A package directory holding `files`, the PackageCatalogFiles under test, and a way to read a file back by a path relative to the package (undefined when absent). */
export interface PackageCatalogFilesFixture {
  readonly files: PackageCatalogFiles;
  readonly packageDir: string;
  read(path: string): Promise<string | undefined>;
}

/** The behaviour every PackageCatalogFiles must have. */
export function packageCatalogFilesConformance(name: string, fixture: (files: Record<string, string>) => Promise<PackageCatalogFilesFixture>): void {
  describe(`${name} conforms to PackageCatalogFiles`, () => {
    test("reads package.json raw: its fields as written, unknown ones kept", async () => {
      const manifest = { name: "demo-package", version: "1.0.0", bounded: { catalog: "./bounded.catalog.json", packs: { "./demo": "packs/demo" } }, extra: { kept: true } };
      const given = await fixture({ "package.json": JSON.stringify(manifest) });
      expect(await given.files.readManifest(given.packageDir)).toEqual({ ok: true, value: manifest });
    });

    test("refuses a missing or unparseable package.json, naming it", async () => {
      const missing = await fixture({});
      const absent = await missing.files.readManifest(missing.packageDir);
      expect(absent.ok).toBe(false);
      expect(!absent.ok && absent.error).toContain("package.json");
      const broken = await fixture({ "package.json": "{ not json" });
      const unparseable = await broken.files.readManifest(broken.packageDir);
      expect(unparseable.ok).toBe(false);
      expect(!unparseable.ok && unparseable.error).toContain("package.json");
    });

    test("reads a missing file as null, and a present one as its text", async () => {
      const given = await fixture({ "packs/demo/README.md": "# demo-package/demo: a pack\n" });
      expect(await given.files.readText(given.packageDir, "packs/demo/README.md")).toEqual({ ok: true, value: "# demo-package/demo: a pack\n" });
      expect(await given.files.readText(given.packageDir, "packs/other/README.md")).toEqual({ ok: true, value: null });
    });

    test("lists only examples/*.config.ts, sorted, by package-relative path; none when there is no examples/", async () => {
      const given = await fixture({
        "packs/demo/examples/b.config.ts": "export default 1;\n",
        "packs/demo/examples/a.config.ts": "export default 1;\n",
        "packs/demo/examples/notes.md": "notes\n",
        "packs/demo/examples/helper.ts": "export {};\n",
        "packs/demo/examples/nested/c.config.ts": "export default 1;\n",
        "packs/demo/d.config.ts": "export default 1;\n",
        "packs/plain/index.ts": "export {};\n",
      });
      expect(await given.files.listExamples(given.packageDir, "packs/demo")).toEqual({ ok: true, value: ["packs/demo/examples/a.config.ts", "packs/demo/examples/b.config.ts"] });
      expect(await given.files.listExamples(given.packageDir, "packs/plain")).toEqual({ ok: true, value: [] });
    });

    test("lists a pack's example scenarios, sorted, and none without examples/", async () => {
      const given = await fixture({
        "packs/demo/examples/b.scenarios.ts": "export default 1;\n",
        "packs/demo/examples/a.scenarios.ts": "export default 1;\n",
        "packs/demo/examples/a.config.ts": "export default 1;\n",
        "packs/demo/examples/notes.md": "notes\n",
        "packs/demo/examples/nested/c.scenarios.ts": "export default 1;\n",
        "packs/demo/d.scenarios.ts": "export default 1;\n",
        "packs/plain/index.ts": "export {};\n",
      });
      expect(await given.files.listExampleScenarios(given.packageDir, "packs/demo")).toEqual({ ok: true, value: ["packs/demo/examples/a.scenarios.ts", "packs/demo/examples/b.scenarios.ts"] });
      expect(await given.files.listExampleScenarios(given.packageDir, "packs/plain")).toEqual({ ok: true, value: [] });
    });

    test("writes a file inside the package, naming it, and refuses to write outside the package", async () => {
      const given = await fixture({ "package.json": "{}" });
      expect(await given.files.write(given.packageDir, "bounded.catalog.json", "{}\n")).toEqual({ ok: true, value: "bounded.catalog.json" });
      expect(await given.read("bounded.catalog.json")).toBe("{}\n");
      for (const outside of ["../escaped.catalog.json", "packs/../../escaped.catalog.json", "/tmp/escaped.catalog.json"]) {
        const written = await given.files.write(given.packageDir, outside, "{}\n");
        expect({ outside, ok: written.ok }).toEqual({ outside, ok: false });
        expect(!written.ok && written.error).toContain(outside);
      }
      expect(await given.read("../escaped.catalog.json")).toBeUndefined();
    });
  });
}
