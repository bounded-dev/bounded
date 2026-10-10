import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoPackage, REPOSITORY_ROOT } from "../../../application/catalog/build-package-catalog/build-package-catalog.demo-package.test-support.ts";
import { packSourceApiConformance } from "../../../application/catalog/build-package-catalog/build-package-catalog.pack-source-api.test-support.ts";
import { TypeScriptPackSourceApi } from "./pack-source-api.ts";

packSourceApiConformance("TypeScriptPackSourceApi", async (changes = {}) => ({
  sourceApi: new TypeScriptPackSourceApi(),
  packageDir: await demoPackage({ build: false, ...(changes.files === undefined ? {} : { files: changes.files }), ...(changes.remove === undefined ? {} : { remove: changes.remove }) }),
}));

const request = (packageDir: string) => ({ packageDir, packDir: "packs/demo", exportName: "demoPack", examplePaths: ["packs/demo/examples/basic.config.ts"] });

describe("TypeScriptPackSourceApi", () => {
  test("refuses, naming the library and the fix, when typescript cannot be resolved from the package", async () => {
    const packageDir = await demoPackage({ build: false, libraries: ["ts-json-schema-generator", "marked"] });
    const read = await new TypeScriptPackSourceApi().read(request(packageDir));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain("install typescript as a devDependency");
  });

  test("refuses, naming both versions, when ts-json-schema-generator resolves another copy of typescript than the package's", async () => {
    const packageDir = await demoPackage({ build: false, libraries: ["typescript", "marked"] });
    // A generator that is the repository's, installed with a typescript of its own, as a nested install would leave it.
    const generator = join(packageDir, "node_modules", "ts-json-schema-generator");
    mkdirSync(join(generator, "dist"), { recursive: true });
    writeFileSync(join(generator, "package.json"), JSON.stringify({ name: "ts-json-schema-generator", version: "2.9.0", main: "dist/index.js" }));
    writeFileSync(join(generator, "dist", "index.js"), `module.exports = require(${JSON.stringify(join(REPOSITORY_ROOT, "node_modules", "ts-json-schema-generator", "dist", "index.js"))});\n`);
    const nested = join(generator, "node_modules", "typescript");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "typescript", version: "5.8.0", main: "index.js" }));
    writeFileSync(join(nested, "index.js"), "module.exports = {};\n");
    const read = await new TypeScriptPackSourceApi().read(request(packageDir));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain("5.8.0");
    expect(!read.ok && read.error).toContain("5.9.3");
    expect(!read.ok && read.error).toContain("ts-json-schema-generator");
  });
});
