import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSetupFilesConformance } from "../../../application/project-setup/init-project/init-project.project-setup-files.test-support.ts";
import { PROJECT_CONFIG_NAMES } from "../project-config-source/project-config-names.ts";
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
  test("configFileNames lists the names of PROJECT_CONFIG_NAMES present, in its order", async () => {
    const root = project({});
    for (const name of [...PROJECT_CONFIG_NAMES].reverse()) writeFileSync(join(root, name), "export default 1;\n");
    expect(await new FileSystemProjectSetupFiles().configFileNames(root)).toEqual({ ok: true, value: [...PROJECT_CONFIG_NAMES] });
    const empty = project({});
    expect(await new FileSystemProjectSetupFiles().createConfig(empty, "export default 1;\n")).toEqual({ ok: true, value: PROJECT_CONFIG_NAMES[0] });
    expect(readFileSync(join(empty, PROJECT_CONFIG_NAMES[0]), "utf8")).toBe("export default 1;\n");
  });

  test("refuses to list a directory that does not exist, naming it", async () => {
    const missing = join(tmpdir(), "bounded-setup-missing", String(Date.now()));
    const listed = await new FileSystemProjectSetupFiles().configFileNames(missing);
    expect(!listed.ok && listed.error.includes(missing)).toBe(true);
  });
});
