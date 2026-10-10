import { describe, expect, test } from "bun:test";
import { demoPackage } from "../../../application/catalog/build-package-catalog/build-package-catalog.demo-package.test-support.ts";
import { markdownSectionsConformance } from "../../../application/catalog/build-package-catalog/build-package-catalog.markdown-sections.test-support.ts";
import { MarkedMarkdownSections } from "./markdown-sections.ts";

markdownSectionsConformance("MarkedMarkdownSections", async () => ({ sections: new MarkedMarkdownSections(), packageDir: await demoPackage({ build: false }) }));

describe("MarkedMarkdownSections", () => {
  test("refuses, naming the library and the fix, when marked cannot be resolved from the package", async () => {
    const packageDir = await demoPackage({ build: false, libraries: ["typescript", "ts-json-schema-generator"] });
    const read = await new MarkedMarkdownSections().read(packageDir, "# demo-package/demo: a pack\n");
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain("install marked as a devDependency");
  });
});
