// The project files `bounded init` and `bounded update` read and write, on disk.
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectSetupFiles } from "bounded/application";
import type { Result } from "bounded/domain";

const CONFIG_NAMES = ["bounded.config.ts", "bounded.config.js", "bounded.config.mjs"] as const;

const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

export class FileSystemProjectSetupFiles implements ProjectSetupFiles {
  async configFileNames(projectRoot: string): Promise<Result<readonly string[]>> {
    try {
      const entries = new Set(await readdir(projectRoot));
      return { ok: true, value: CONFIG_NAMES.filter((name) => entries.has(name)) };
    } catch (thrown) {
      return { ok: false, error: `${projectRoot} cannot be read: ${message(thrown)}` };
    }
  }

  async createConfig(projectRoot: string, content: string): Promise<Result<string>> {
    const [name] = CONFIG_NAMES;
    try {
      // "wx": fail when the file exists, so an existing configuration is never overwritten.
      await writeFile(join(projectRoot, name), content, { flag: "wx" });
      return { ok: true, value: name };
    } catch (thrown) {
      return { ok: false, error: `${name} could not be created in ${projectRoot}: ${message(thrown)}` };
    }
  }
}
