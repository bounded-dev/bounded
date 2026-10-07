import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProjectConfigSource } from "bounded/application";
import { type Config, isConfig, type Result } from "bounded/domain";

const NAMES = ["bounded.config.ts", "bounded.config.js", "bounded.config.mjs"];
const FORM = "export default defineConfig({ packs: [...] })";

function text(thrown: unknown): string {
  try {
    return String(thrown instanceof Error ? (thrown.message as unknown) : thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

function described(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return "an object that defineConfig did not make";
  return /^[aeiou]/.test(typeof value) ? `an ${typeof value}` : `a ${typeof value}`;
}

/** Loads `<root>/bounded.config.ts` (or .js, .mjs) by importing it; its default export must be made by defineConfig. */
export class FileSystemProjectConfigSource implements ProjectConfigSource {
  async load(root: string): Promise<Result<Config>> {
    const found = NAMES.filter((name) => existsSync(join(root, name)));
    const [name] = found;
    if (name === undefined) return { ok: false, error: `No configuration in ${root}: create bounded.config.ts there with ${FORM}` };
    if (found.length > 1) return { ok: false, error: `More than one configuration in ${root} (${found.join(", ")}): keep one` };
    let module: Record<string, unknown>;
    try {
      module = await import(pathToFileURL(join(root, name)).href);
    } catch (thrown) {
      return { ok: false, error: `${name} could not be loaded: ${text(thrown)}` };
    }
    if (!Object.hasOwn(module, "default")) return { ok: false, error: `${name} must ${FORM}; it has no default export` };
    const config = module.default;
    if (!isConfig(config)) return { ok: false, error: `${name} must ${FORM}; its default export is ${described(config)}` };
    return { ok: true, value: config };
  }
}
