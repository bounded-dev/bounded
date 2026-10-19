// The modules a package's export paths name, loaded under bun (ADRs 2026-029 and 2026-032).
// Hosts load packs under Node, so the build loads the JavaScript Node's require would pick: the
// package's own package.json says what each export path's entry is, and its target under
// default, require or node (never a `bun` source) is joined to the package's directory and
// imported; an entry with no such target is refused before anything else is read, and a target
// that does not exist is refused with "build the package first". With no exports, the package
// root loads through main, as Node's require resolves it. A module by its package-relative path
// (an example's scenarios, ADR 2026-031) is imported as bun imports TypeScript, under
// node_modules too. Under any other runtime both refuse before reading anything: the build runs
// under bun only. It detects bun through process.versions and uses no Bun API, so the module
// still loads under Node, where hosts run the core.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModuleExport, PackModules } from "bounded/application";
import type { Result } from "bounded/domain";

/** The conditions Node's require picks a target by. */
const NODE_CONDITIONS: readonly string[] = ["default", "require", "node"];
const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The refusal under any runtime but bun, or undefined under bun. */
function notUnderBun(): string | undefined {
  if (process.versions.bun !== undefined) return undefined;
  const found = process.versions.node === undefined ? "a runtime other than bun" : `Node ${process.version}`;
  return `the catalogue build loads packs under bun, and this is ${found}: run it under bun, with bunx --bun bounded catalog build`;
}

/**
 * The target Node's require picks from an export entry, or undefined when it picks none: a string is itself; a list,
 * its first entry that gives a target; conditions, their keys in written order, the first of default, require or node
 * that gives a target, at any depth.
 */
function nodeTargetOf(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) {
    for (const item of entry) {
      const target = nodeTargetOf(item);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (!isRecord(entry)) return undefined;
  for (const [condition, value] of Object.entries(entry)) {
    if (!NODE_CONDITIONS.includes(condition)) continue;
    const target = nodeTargetOf(value);
    if (target !== undefined) return target;
  }
  return undefined;
}

/**
 * The entry package.json's `exports` gives an export path, or undefined when it gives none. `exports` is a map of
 * export paths (its keys begin with `.`), or else the package root's own entry: a path, a list, or conditions.
 */
function entryOf(exports: unknown, exportPath: string): unknown {
  if (isRecord(exports) && Object.keys(exports).some((key) => key.startsWith("."))) return Object.hasOwn(exports, exportPath) ? exports[exportPath] : undefined;
  return exports === undefined || exports === null || exportPath !== "." ? undefined : exports;
}

/** Whether `path`, resolved from the package's directory, names a file inside it. */
function isInside(packageDir: string, path: string): boolean {
  if (isAbsolute(path)) return false;
  const within = relative(resolve(packageDir), resolve(packageDir, path));
  return within !== "" && within.split(sep)[0] !== ".." && !isAbsolute(within);
}

/** Every export of the module at `file`, named `specifier` in refusals. */
async function exportsOf(file: string, specifier: string): Promise<Result<readonly ModuleExport[]>> {
  let module: unknown;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (thrown) {
    return { ok: false, error: `${specifier} cannot be loaded (${message(thrown)})` };
  }
  if (!isRecord(module)) return { ok: false, error: `${specifier} is not a module` };
  return { ok: true, value: Object.keys(module).map((exportName) => Object.freeze({ name: exportName, value: module[exportName] })) };
}

export class BunPackModules implements PackModules {
  async load(packageDir: string, exportPath: string): Promise<Result<readonly ModuleExport[]>> {
    const refusal = notUnderBun();
    if (refusal !== undefined) return { ok: false, error: refusal };
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
    if (exports === undefined && exportPath === ".") {
      // With no exports, Node's require resolves the package root through main (or index.js), and nothing else.
      let resolved: string;
      try {
        resolved = createRequire(manifestPath).resolve(packageDir);
      } catch (thrown) {
        return { ok: false, error: `${name} has no exports, and neither a main nor an index.js resolves (${message(thrown)}): add main or exports to its package.json, naming the pack's built JavaScript` };
      }
      return exportsOf(resolved, packageDir);
    }
    const entry = entryOf(exports, exportPath);
    if (entry === undefined) return { ok: false, error: `${name} has no export path ${exportPath}: add it to package.json's exports, or list in bounded.packs the export path its pack is exported from` };
    const target = nodeTargetOf(entry);
    if (target === undefined) {
      return { ok: false, error: `${name}'s export path ${exportPath} has no target Node's require picks (default, require or node): add a \`default\` condition naming its JavaScript, which hosts load under Node and the catalogue build loads too` };
    }
    // The package root, `.`, is the bare package name; any other export path is `<name>/<subpath>`.
    const specifier = exportPath === "." ? name : `${name}${exportPath.slice(1)}`;
    if (!isInside(packageDir, target)) return { ok: false, error: `${name}'s export path ${exportPath} names ${target}, which is not a file in the package at ${packageDir}: name the package's own JavaScript` };
    const file = resolve(packageDir, target);
    if (!existsSync(file)) return { ok: false, error: `${specifier}'s target ${target} does not exist in ${packageDir}: build the package first, so its export path's target exists` };
    return exportsOf(file, specifier);
  }

  async loadDefaultExport(packageDir: string, path: string): Promise<Result<unknown>> {
    const refusal = notUnderBun();
    if (refusal !== undefined) return { ok: false, error: refusal };
    // Inside the package only: a package-relative path that is absolute or climbs out names no file of it.
    if (!isInside(packageDir, path)) return { ok: false, error: `${path} is not a file in the package at ${packageDir}` };
    let module: unknown;
    try {
      module = await import(pathToFileURL(resolve(packageDir, path)).href);
    } catch (thrown) {
      return { ok: false, error: `${path} cannot be loaded (${message(thrown)})` };
    }
    if (!isRecord(module) || !Object.hasOwn(module, "default")) return { ok: false, error: `${path} has no default export: export its value with \`export default\`` };
    return { ok: true, value: module.default };
  }
}
