import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProjectConfigSource } from "bounded/application";
import { corePack, defineConfig } from "bounded/domain";
import { projectConfigSourceConformance } from "../../../application/project-config/open-project/open-project.project-config-source.test-support.ts";
import { CheckedProjectConfigSource } from "./checked-project-config-source.ts";
import { FileSystemProjectConfigSource } from "./file-system-project-config-source.ts";

const ROOT = "/work/project";
const checked = (load: () => Promise<unknown>) => new CheckedProjectConfigSource({ load } as ProjectConfigSource);

const CORE = resolve(import.meta.dir, "../../../..");
const VALID = `import { corePack, defineConfig } from "bounded/domain";\nexport default defineConfig({ packs: [corePack] });\n`;

/** A temporary project holding `files`, where `bounded` resolves to this workspace's package. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "bounded-checked-project-"));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(CORE, join(root, "node_modules", "bounded"), "dir");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

// Wrapping the file-system source, as openProject does, it keeps the port's behaviour.
projectConfigSourceConformance("CheckedProjectConfigSource", async (kind) => ({
  source: new CheckedProjectConfigSource(new FileSystemProjectConfigSource()),
  root: project(kind === "valid" ? { "bounded.config.ts": VALID } : kind === "not-a-config" ? { "bounded.config.ts": "export default { packs: [] };\n" } : {}),
}));

describe("CheckedProjectConfigSource — a host's configuration source, its answers checked", () => {
  test("a configuration made by defineConfig passes through", async () => {
    const config = defineConfig({ packs: [corePack] });
    expect(await checked(async () => ({ ok: true, value: config })).load(ROOT)).toEqual({ ok: true, value: config });
  });

  test("a refusal passes through with its reason", async () => {
    expect(await checked(async () => ({ ok: false, error: "No configuration in /work/project" })).load(ROOT)).toEqual({ ok: false, error: "No configuration in /work/project" });
  });

  test("a configuration source that throws is a configuration that cannot be loaded", async () => {
    const loaded = await checked(async () => {
      throw new Error("disk gone");
    }).load(ROOT);
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error).toBe("the configuration source failed: disk gone");
  });

  test("a configuration source that returns no result is a configuration that cannot be loaded", async () => {
    for (const answer of [undefined, null, 7, { value: 1 }]) {
      const loaded = await checked(async () => answer).load(ROOT);
      expect(loaded.ok).toBe(false);
      expect(!loaded.ok && loaded.error).toBe("the configuration source returned no result");
    }
    expect(await checked(async () => ({ ok: false, error: 5 })).load(ROOT)).toEqual({ ok: false, error: "the configuration source returned no reason" });
  });

  test("a loaded value that defineConfig did not make is refused", async () => {
    expect(await checked(async () => ({ ok: true, value: { packs: [] } })).load(ROOT)).toEqual({
      ok: false,
      error: "This is not a configuration made by defineConfig: export default defineConfig({ packs: [...] })",
    });
  });
});
