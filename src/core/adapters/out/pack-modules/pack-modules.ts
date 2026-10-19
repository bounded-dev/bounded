// The modules a package's export paths name, loaded under bun (ADRs 2026-029 and 2026-032).
// Hosts load packs under Node with import(), so the build resolves each export path exactly as
// a host's import() does under Node: resolve.exports reads the package's own package.json with
// the conditions node, import and default (never bun, never require), and Node's own rules for
// a target apply (it starts with ./ and has no empty, ., .. or node_modules segment after it; a
// list's invalid entries are skipped). The target is joined to the package's directory, checked
// by path to stay inside it, refused with "build the package first" when it does not exist, and
// imported. With no exports, the package root loads through main (read from package.json, kept
// inside the package), or index.js. A module by its package-relative path (an example's
// scenarios, ADR 2026-031) is imported as bun imports TypeScript, under node_modules too. Under
// any other runtime both refuse before reading anything: the build runs under bun only. It
// detects bun through process.versions and uses no Bun API, so the module still loads under
// Node, where hosts run the core.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModuleExport, PackModules } from "bounded/application";
import type { Result } from "bounded/domain";
import { exports as exportTargets } from "resolve.exports";

const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A segment Node refuses in a package target after its leading `./`: empty, `.`, `..` or `node_modules`, in any case
 * and percent-encoded; Node's own pattern (lib/internal/modules/esm/resolve.js, invalidSegmentRegEx).
 */
const INVALID_SEGMENT = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))?(\\|\/|$)/i;
/** Whether Node takes `target` as a package target: it starts with `./` and has no invalid segment after it. */
const isPackageTarget = (target: string): boolean => target.startsWith("./") && !INVALID_SEGMENT.test(target.slice(2));

/** The refusal under any runtime but bun, or undefined under bun. */
function notUnderBun(): string | undefined {
  if (process.versions.bun !== undefined) return undefined;
  const found = process.versions.node === undefined ? "a runtime other than bun" : `Node ${process.version}`;
  return `the catalogue build loads packs under bun, and this is ${found}: run it under bun, with bunx --bun bounded catalog build`;
}

/** Whether `path`, resolved from the package's directory, names a file inside it; checked by path, so a symlink is followed as Node follows it. */
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

/** The package root of a package with no exports: its main, or else index.js, as Node loads it. */
async function loadThroughMain(packageDir: string, name: string, main: string | undefined): Promise<Result<readonly ModuleExport[]>> {
  if (main === undefined) {
    const index = join(packageDir, "index.js");
    if (!existsSync(index)) return { ok: false, error: `${name} has no exports, and neither a main nor an index.js: add main or exports to its package.json, naming the pack's built JavaScript` };
    return exportsOf(index, name);
  }
  if (!isInside(packageDir, main)) return { ok: false, error: `${name}'s main ${main} is not a file in the package at ${packageDir}: name the package's own JavaScript` };
  const file = resolve(packageDir, main);
  if (!existsSync(file)) return { ok: false, error: `${name}'s main ${main} does not exist in ${packageDir}: build the package first, so its main exists` };
  return exportsOf(file, name);
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
    if (!isRecord(manifest) || typeof manifest.name !== "string") return { ok: false, error: `${manifestPath} names no package: give it a name` };
    const name = manifest.name;
    const noExportPath = `${name} has no export path ${exportPath}: add it to package.json's exports, or list in bounded.packs the export path its pack is exported from`;
    if (manifest.exports === undefined) {
      // With no exports, Node resolves the package root through main (or index.js), and nothing else.
      if (exportPath !== ".") return { ok: false, error: noExportPath };
      return loadThroughMain(packageDir, name, typeof manifest.main === "string" ? manifest.main : undefined);
    }
    let targets: readonly string[];
    try {
      targets = exportTargets(manifest, exportPath, { browser: false, require: false }) ?? [];
    } catch (thrown) {
      // resolve.exports throws `Missing "<path>" specifier …` for a path exports does not list, and otherwise when no condition matches.
      if (message(thrown).startsWith("Missing ")) return { ok: false, error: noExportPath };
      targets = [];
    }
    if (targets.length === 0) {
      return {
        ok: false,
        error: `${name}'s export path ${exportPath} gives a host's import() under Node no target: none of its node, import or default conditions names one, or the one it names is null: add a \`default\` condition naming its JavaScript, which hosts load under Node and the catalogue build loads too`,
      };
    }
    const target = targets.find(isPackageTarget);
    if (target === undefined) {
      return { ok: false, error: `${name}'s export path ${exportPath} names ${targets.join(", ")}, which Node refuses as a package target: a target starts with ./ and has no empty, ., .. or node_modules segment after it` };
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
