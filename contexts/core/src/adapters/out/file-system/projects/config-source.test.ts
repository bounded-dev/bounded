import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isConfig } from "bounded/domain";
import { projectConfigSourceConformance } from "../../../../application/projects/open-project/open-project.config-source.test-support.ts";
import { FileSystemProjectConfigSource } from "./config-source.ts";

const CORE = resolve(import.meta.dir, "../../../../..");
const VALID = `import { corePack, defineConfig } from "bounded/domain";\nexport default defineConfig({ packs: [corePack] });\n`;

/** A temporary project holding `files`, where `bounded` resolves to this workspace's package. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "bounded-project-"));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(CORE, join(root, "node_modules", "bounded"), "dir");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

const source = new FileSystemProjectConfigSource();

projectConfigSourceConformance("FileSystemProjectConfigSource", async (kind) => ({
  source,
  root: project(kind === "valid" ? { "bounded.config.ts": VALID } : kind === "not-a-config" ? { "bounded.config.ts": "export default { packs: [] };\n" } : {}),
}));

describe("FileSystemProjectConfigSource", () => {
  test("loads bounded.config.ts, .js or .mjs", async () => {
    for (const name of ["bounded.config.ts", "bounded.config.js", "bounded.config.mjs"]) {
      const loaded = await source.load(project({ [name]: VALID }));
      expect(loaded.ok && isConfig(loaded.value)).toBe(true);
    }
  });

  test("refuses a project without a configuration", async () => {
    const root = project({});
    expect(await source.load(root)).toEqual({ ok: false, error: `No configuration in ${root}: create bounded.config.ts there with export default defineConfig({ packs: [...] })` });
  });

  test("refuses a project with more than one configuration", async () => {
    const root = project({ "bounded.config.ts": VALID, "bounded.config.mjs": VALID });
    expect(await source.load(root)).toEqual({ ok: false, error: `More than one configuration in ${root} (bounded.config.ts, bounded.config.mjs): keep one` });
  });

  test("refuses a configuration that throws when loaded", async () => {
    const root = project({ "bounded.config.ts": 'throw new Error("half written");\n' });
    expect(await source.load(root)).toEqual({ ok: false, error: "bounded.config.ts could not be loaded: half written" });
  });

  test("refuses a default export that defineConfig did not make, saying what it is", async () => {
    expect(await source.load(project({ "bounded.config.ts": "export default { packs: [] };\n" }))).toEqual({
      ok: false,
      error: "bounded.config.ts must export default defineConfig({ packs: [...] }); its default export is an object that defineConfig did not make",
    });
    expect(await source.load(project({ "bounded.config.ts": "export const packs = [];\n" }))).toEqual({
      ok: false,
      error: "bounded.config.ts must export default defineConfig({ packs: [...] }); it has no default export",
    });
  });
});
