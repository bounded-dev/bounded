import { describe, expect, test } from "bun:test";
import { Config } from "bounded/domain";
import type { ProjectConfigSource } from "./open-project.contract.ts";

/** A project directory set up as asked, and the source that loads it. */
export interface ConfigSourceFixture {
  readonly source: ProjectConfigSource;
  readonly root: string;
}

/** The behaviour every ProjectConfigSource must have. */
export function projectConfigSourceConformance(name: string, fixture: (project: "valid" | "missing" | "not-a-config") => Promise<ConfigSourceFixture>): void {
  describe(`${name} conforms to ProjectConfigSource`, () => {
    test("loads a project's configuration made by defineConfig", async () => {
      const { source, root } = await fixture("valid");
      const loaded = await source.load(root);
      expect(loaded.ok && Config.parse(loaded.value).ok).toBe(true);
    });

    test("refuses a project without a configuration, saying how to add one", async () => {
      const { source, root } = await fixture("missing");
      const loaded = await source.load(root);
      expect(!loaded.ok && loaded.error.includes("defineConfig")).toBe(true);
    });

    test("refuses a configuration that defineConfig did not make", async () => {
      const { source, root } = await fixture("not-a-config");
      const loaded = await source.load(root);
      expect(loaded.ok).toBe(false);
    });
  });
}
