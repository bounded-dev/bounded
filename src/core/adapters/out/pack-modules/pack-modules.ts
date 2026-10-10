// The modules a package's export paths name, loaded as Node loads them (ADR 2026-026). The
// package's own package.json says what each export path's entry is; an entry with no target
// Node's require picks (default, require or node) is refused before anything is resolved, so
// the refusal is the same under every runtime. Otherwise the export path is resolved by
// self-reference, `<package name>/<subpath>` from the package's own package.json, and imported.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModuleExport, PackModules } from "bounded/application";
import type { Result } from "bounded/domain";

/** The conditions Node's require picks a target by. */
const NODE_CONDITIONS = ["default", "require", "node"];
const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether an export entry has a target under default, require or node: a path, or conditions holding one, at any depth. */
function hasNodeTarget(entry: unknown): boolean {
  if (typeof entry === "string") return true;
  if (Array.isArray(entry)) return entry.some(hasNodeTarget);
  if (!isRecord(entry)) return false;
  return NODE_CONDITIONS.some((condition) => condition in entry && hasNodeTarget(entry[condition]));
}

export class NodePackModules implements PackModules {
  async load(packageDir: string, exportPath: string): Promise<Result<readonly ModuleExport[]>> {
    const manifestPath = join(packageDir, "package.json");
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (thrown) {
      return { ok: false, error: `${manifestPath} cannot be read: ${message(thrown)}` };
    }
    const name = isRecord(manifest) && typeof manifest.name === "string" ? manifest.name : undefined;
    const exports = isRecord(manifest) ? manifest.exports : undefined;
    if (name === undefined) return { ok: false, error: `${manifestPath} names no package: give it a name` };
    if (!isRecord(exports) || !(exportPath in exports)) return { ok: false, error: `${name} has no export path ${exportPath}: add it to package.json's exports, or list in bounded.packs the export path its pack is exported from` };
    if (!hasNodeTarget(exports[exportPath])) {
      return { ok: false, error: `${name}'s export path ${exportPath} has no target Node's require resolves (default, require or node): add a \`default\` condition naming its JavaScript, since the catalogue build loads packs under Node` };
    }
    const specifier = `${name}${exportPath.slice(1)}`;
    let resolved: string;
    try {
      resolved = createRequire(manifestPath).resolve(specifier);
    } catch (thrown) {
      return { ok: false, error: `${specifier} cannot be resolved from ${packageDir} (${message(thrown)}): build the package first, so its export path's target exists` };
    }
    let module: unknown;
    try {
      module = await import(pathToFileURL(resolved).href);
    } catch (thrown) {
      return { ok: false, error: `${specifier} cannot be loaded (${message(thrown)})` };
    }
    if (!isRecord(module)) return { ok: false, error: `${specifier} is not a module` };
    return { ok: true, value: Object.keys(module).map((exportName) => Object.freeze({ name: exportName, value: module[exportName] })) };
  }
}
