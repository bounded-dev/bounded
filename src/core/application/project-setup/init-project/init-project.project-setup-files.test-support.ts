import { describe, expect, test } from "bun:test";
import type { ProjectSetupFiles } from "./init-project.contract.ts";

/** A project directory holding `files`, the ProjectSetupFiles under test, and a way to read a file back (undefined when absent). */
export interface ProjectSetupFilesFixture {
  readonly files: ProjectSetupFiles;
  readonly root: string;
  read(name: string): Promise<string | undefined>;
}

/** The behaviour every ProjectSetupFiles must have. */
export function projectSetupFilesConformance(name: string, fixture: (files: Record<string, string>) => Promise<ProjectSetupFilesFixture>): void {
  describe(`${name} conforms to ProjectSetupFiles`, () => {
    test("lists the configuration files a project has, of bounded.config.ts, .js and .mjs", async () => {
      const empty = await fixture({ "README.md": "hello\n" });
      expect(await empty.files.configFileNames(empty.root)).toEqual({ ok: true, value: [] });
      const two = await fixture({ "bounded.config.mjs": "x\n", "bounded.config.ts": "y\n" });
      expect(await two.files.configFileNames(two.root)).toEqual({ ok: true, value: ["bounded.config.ts", "bounded.config.mjs"] });
    });

    test("creates bounded.config.ts with the content given, naming the file", async () => {
      const project = await fixture({});
      expect(await project.files.createConfig(project.root, "export default 1;\n")).toEqual({ ok: true, value: "bounded.config.ts" });
      expect(await project.read("bounded.config.ts")).toBe("export default 1;\n");
    });

    test("never overwrites an existing bounded.config.ts", async () => {
      const project = await fixture({ "bounded.config.ts": "mine\n" });
      const created = await project.files.createConfig(project.root, "theirs\n");
      expect(created.ok).toBe(false);
      expect(await project.read("bounded.config.ts")).toBe("mine\n");
    });
  });
}
