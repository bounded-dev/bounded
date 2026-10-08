import { existsSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { ProjectConfigSource } from "bounded/application";
import { Config, type Result } from "bounded/domain";
import { loadConfigAsModule } from "./config-as-module.ts";
import { loadFailure } from "./load-failure.ts";

const NAMES = ["bounded.config.ts", "bounded.config.js", "bounded.config.mjs"];
const FORM = "export default defineConfig({ packs: [...] })";

function described(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return "an object that defineConfig did not make, or that another copy of bounded made";
  return /^[aeiou]/.test(typeof value) ? `an ${typeof value}` : `a ${typeof value}`;
}

/**
 * Loads `<root>/bounded.config.ts` (or .js, .mjs) by importing it; its default
 * export must be made by defineConfig. Each load imports the file as it is
 * now (keyed by its modification time), so a changed configuration is read
 * afresh. A file that resolves outside the project is refused.
 */
export class FileSystemProjectConfigSource implements ProjectConfigSource {
  async load(projectRoot: string): Promise<Result<Config>> {
    const found = NAMES.filter((name) => existsSync(join(projectRoot, name)));
    const [name] = found;
    if (name === undefined) return { ok: false, error: `No configuration in ${projectRoot}: create bounded.config.ts (or bounded.config.js, bounded.config.mjs) there with ${FORM}` };
    if (found.length > 1) return { ok: false, error: `More than one configuration in ${projectRoot} (${found.join(", ")}): keep one` };
    let module: Record<string, unknown>;
    try {
      const file = realpathSync(join(projectRoot, name));
      const home = realpathSync(projectRoot);
      if (!file.startsWith(home + sep)) return { ok: false, error: `${name} resolves outside ${projectRoot}: the configuration must live in the project` };
      // An ES module under node whatever the project's package.json says (config-as-module.ts).
      loadConfigAsModule();
      // A query on the path (not a file: URL) makes the runtime load the file afresh when it changed.
      module = await import(`${file}?v=${statSync(file).mtimeMs}`);
    } catch (thrown) {
      return { ok: false, error: loadFailure(name, thrown) };
    }
    if (!Object.hasOwn(module, "default")) return { ok: false, error: `${name} must ${FORM}; it has no default export` };
    const config = Config.parse(module.default);
    return config.ok ? config : { ok: false, error: `${name} must ${FORM}; its default export is ${described(module.default)}` };
  }
}
