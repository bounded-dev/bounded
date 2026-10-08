import { describe, expect, test } from "bun:test";
import type { ProjectConfigSource } from "bounded/application";
import { corePack, defineConfig } from "bounded/domain";
import { CheckedProjectConfigSource } from "./checked-config-source.ts";

const ROOT = "/work/project";
const checked = (load: () => Promise<unknown>) => new CheckedProjectConfigSource({ load } as ProjectConfigSource);

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
