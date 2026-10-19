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

  /** The refusal of an export path whose entry gives a host's import() under Node no target. */
  const notExported = (exportPath: string): string =>
    `demo-package's export path ${exportPath} gives a host's import() under Node no target: none of its node, import or default conditions names one, or the one it names is null: add a \`default\` condition naming its JavaScript, which hosts load under Node and the catalogue build loads too`;
  /** The refusal of an export path whose every target Node refuses as a package target. */
  const invalidTarget = (targets: string): string =>
    `demo-package's export path ./demo names ${targets}, which Node refuses as a package target: a target starts with ./ and has no empty, ., .. or node_modules segment after it`;

  test("refuses a target with no leading ./, as Node does", async () => {
    const packageDir = await packageWith({ default: "dist/demo/index.js" });
    expect(await new BunPackModules().load(packageDir, "./demo")).toEqual({ ok: false, error: invalidTarget("dist/demo/index.js") });
  });

  test("refuses a target with a .. segment, as Node does, though it stays inside the package", async () => {
    const packageDir = await packageWith("./dist/../dist/demo/index.js");
    expect(await new BunPackModules().load(packageDir, "./demo")).toEqual({ ok: false, error: invalidTarget("./dist/../dist/demo/index.js") });
  });

  test("refuses a target that climbs out of the package, as Node does", async () => {
    const packageDir = await packageWith({ default: "../elsewhere/index.js" });
    expect(await new BunPackModules().load(packageDir, "./demo")).toEqual({ ok: false, error: invalidTarget("../elsewhere/index.js") });
  });

  test("refuses a node condition of null as not exported, though a default target follows", async () => {
    const packageDir = await packageWith({ node: null, default: "./dist/demo/index.js" });
    expect(await new BunPackModules().load(packageDir, "./demo")).toEqual({ ok: false, error: notExported("./demo") });
  });

  test("skips a list's invalid entries and loads its first valid one, as Node does", async () => {
    const packageDir = await packageWith(["dist/x.js", "./dist/demo/index.js"]);
    const loaded = await new BunPackModules().load(packageDir, "./demo");
    expect(loaded.ok ? "ok" : loaded.error).toBe("ok");
    expect(loaded.ok && loaded.value.map(({ name }) => name)).toContain("demoPack");
  });

  test("refuses a require-only entry, which import() cannot reach, in full", async () => {
    const packageDir = await packageWith({ require: "./dist/demo/index.js" });
    expect(await new BunPackModules().load(packageDir, "./demo")).toEqual({ ok: false, error: notExported("./demo") });
  });

  test("takes the import target over default, and refuses it when it was never built", async () => {
    const packageDir = await packageWith({ import: "./dist/demo/index.mjs", default: "./dist/demo/index.js" });
    expect(await new BunPackModules().load(packageDir, "./demo")).toEqual({
      ok: false,
      error: `demo-package/demo's target ./dist/demo/index.mjs does not exist in ${packageDir}: build the package first, so its export path's target exists`,
    });
  });

  test("takes the first of node, import or default in written order, never bun or require", async () => {
    const packageDir = await packageWith({ bun: "./packs/demo/missing.ts", require: "./missing.js", node: { import: "./dist/demo/index.js" }, default: "./missing.js" });
    const loaded = await new BunPackModules().load(packageDir, "./demo");
    expect(loaded.ok ? "ok" : loaded.error).toBe("ok");
  });

  test("refuses a main that climbs out of the package, naming it", async () => {
    const packageDir = await packageWith(undefined, undefined, "../x.js");
    expect(await new BunPackModules().load(packageDir, ".")).toEqual({
      ok: false,
      error: `demo-package's main ../x.js is not a file in the package at ${packageDir}: name the package's own JavaScript`,
    });
  });

  test("loads main, never the module field, when package.json has no exports", async () => {
    const packageDir = await demoPackage({
      manifest: ({ exports: _exports, ...manifest }) => ({ ...manifest, main: "./dist/demo/index.js", module: "./throws.js" }),
      files: { "throws.js": 'throw new Error("the catalogue build loaded the module field");\n' },
    });
    const loaded = await new BunPackModules().load(packageDir, ".");
    expect(loaded.ok ? "ok" : loaded.error).toBe("ok");
    expect(loaded.ok && loaded.value.map(({ name }) => name)).toContain("demoPack");
  });
});
