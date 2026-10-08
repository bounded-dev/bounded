import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSetupFilesConformance } from "../../../../application/project-setup/init-project/init-project.project-setup-files.test-support.ts";
import { FileSystemProjectSetupFiles } from "./project-setup-files.ts";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "bounded-setup-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

projectSetupFilesConformance("FileSystemProjectSetupFiles", async (files) => {
  const root = project(files);
  return {
    files: new FileSystemProjectSetupFiles(),
    root,
    read: async (name) => {
      try {
        return readFileSync(join(root, name), "utf8");
      } catch {
        return undefined;
      }
    },
  };
});

describe("FileSystemProjectSetupFiles", () => {
  test("refuses to list a directory that does not exist, naming it", async () => {
    const missing = join(tmpdir(), "bounded-setup-missing", String(Date.now()));
    const listed = await new FileSystemProjectSetupFiles().configFileNames(missing);
    expect(!listed.ok && listed.error.includes(missing)).toBe(true);
  });
});
