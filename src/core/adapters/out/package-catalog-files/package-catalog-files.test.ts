import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packageCatalogFilesConformance } from "../../../application/catalog/build-package-catalog/build-package-catalog.package-catalog-files.test-support.ts";
import { FileSystemPackageCatalogFiles } from "./package-catalog-files.ts";

packageCatalogFilesConformance("FileSystemPackageCatalogFiles", async (files) => {
  // The package sits one level down, so a write that escapes it lands in a directory the test can read.
  const packageDir = join(realpathSync(mkdtempSync(join(tmpdir(), "bounded-catalog-files-"))), "package");
  mkdirSync(packageDir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(packageDir, path)), { recursive: true });
    writeFileSync(join(packageDir, path), text);
  }
  return {
    files: new FileSystemPackageCatalogFiles(),
    packageDir,
    read: async (path) => {
      try {
        return readFileSync(join(packageDir, path), "utf8");
      } catch {
        return undefined;
      }
    },
  };
});
