import { describe, expect, test } from "bun:test";
import { demoPackage } from "../../../application/catalog/build-package-catalog/build-package-catalog.demo-package.test-support.ts";
import { packSourceApiConformance } from "../../../application/catalog/build-package-catalog/build-package-catalog.pack-source-api.test-support.ts";
import { TypeScriptPackSourceApi } from "./pack-source-api.ts";

packSourceApiConformance("TypeScriptPackSourceApi", async (changes = {}) => ({
  sourceApi: new TypeScriptPackSourceApi(),
  packageDir: await demoPackage({ build: false, ...(changes.files === undefined ? {} : { files: changes.files }), ...(changes.remove === undefined ? {} : { remove: changes.remove }) }),
}));

describe("TypeScriptPackSourceApi", () => {
  test("refuses, naming the library and the fix, when typescript cannot be resolved from the package", async () => {
    const packageDir = await demoPackage({ build: false, libraries: ["ts-json-schema-generator", "marked"] });
    const read = await new TypeScriptPackSourceApi().read({ packageDir, packDir: "packs/demo", examplePaths: ["packs/demo/examples/basic.config.ts"] });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain("install typescript as a devDependency");
  });
});
