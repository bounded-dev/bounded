// The modules a package's export paths name, loaded under bun (ADRs 2026-029 and 2026-032).
// Hosts load packs under Node with import(), so the build resolves each export path exactly as
// a host's import() does under Node at or above bounded's engines floor (22.18): by Node's
// documented ESM resolution algorithm for package exports, step for step
// (https://nodejs.org/api/esm.html#resolution-algorithm-specification: PACKAGE_EXPORTS_RESOLVE,
// PACKAGE_IMPORTS_EXPORTS_RESOLVE, PATTERN_KEY_COMPARE and PACKAGE_TARGET_RESOLVE), with the
// conditions node, import, module-sync and default (never bun, never require). Where Node's
// implementation (lib/internal/modules/esm/resolve.js) is narrower than the text, it is
// followed, and said so below. The target is resolved as a URL against the package's directory,
// as Node resolves it (an encoded / or \ refused), checked by path to stay inside it, refused
// with "build the package first" when it does not exist, and imported. With no exports (or
// exports of null), the package root loads through main (read from package.json, kept inside
// the package, naming an existing file: Node's deprecated lookup of main is not followed), or
// index.js. A module by its package-relative
// path (an example's scenarios, ADR 2026-031) is imported as bun imports TypeScript, under
// node_modules too. Under any other runtime both refuse before reading anything: the build runs
// under bun only. It detects bun through process.versions and uses no Bun API, so the module
// still loads under Node, where hosts run the core.
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ModuleExport, PackModules } from "bounded/application";
import type { Result } from "bounded/domain";
import { isInvalidModuleSpecifier, isInvalidPackageConfiguration, isInvalidPackageTarget, packageExportsResolve } from "./node-import-export-target.ts";

const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

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

/** Whether the absolute path `file` lies inside the package's directory; checked by path, so a symlink is followed as Node follows it. */
function isWithin(packageDir: string, file: string): boolean {
  const within = relative(resolve(packageDir), file);
  return within !== "" && within.split(sep)[0] !== ".." && !isAbsolute(within);
}

/** A percent-encoded "/" or "\": Node's encodedSepRegEx, which its finalizeResolution refuses in a resolved URL's path. */
const ENCODED_SEPARATOR = /%2F|%5C/i;

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

/**
 * The package root of a package with no exports: its main, or else index.js. Stricter than Node: main must name an
 * existing file, extension included; Node's deprecated lookup (main.js, main/index.js and the like) is not followed.
 */
async function loadThroughMain(packageDir: string, name: string, main: string | undefined): Promise<Result<readonly ModuleExport[]>> {
  if (main === undefined) {
    const index = join(packageDir, "index.js");
    if (!existsSync(index)) return { ok: false, error: `${name} has no exports, and neither a main nor an index.js: add main or exports to its package.json, naming the pack's built JavaScript` };
    return exportsOf(index, name);
  }
  if (!isInside(packageDir, main)) return { ok: false, error: `${name}'s main ${main} is not a file in the package at ${packageDir}: name the package's own JavaScript` };
  const file = resolve(packageDir, main);
  if (!existsSync(file) || !statSync(file).isFile()) {
    return {
      ok: false,
      error: `${name}'s main ${main} names no file in ${packageDir}: name the built file itself, extension included (the build does not follow Node's deprecated lookup of main with an extension or an index.js), or build the package first`,
    };
  }
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
    // With no exports (Node reads exports of null as none), the package root resolves through main (or index.js), and nothing else.
    if (manifest.exports === undefined || manifest.exports === null) {
      if (exportPath !== ".") return { ok: false, error: noExportPath };
      return loadThroughMain(packageDir, name, typeof manifest.main === "string" ? manifest.main : undefined);
    }
    let resolution: ReturnType<typeof packageExportsResolve>;
    try {
      resolution = packageExportsResolve(manifest.exports, exportPath);
    } catch (thrown) {
      if (isInvalidPackageTarget(thrown)) {
        const target = typeof thrown.target === "string" ? thrown.target : JSON.stringify(thrown.target);
        return { ok: false, error: `${name}'s export path ${exportPath} names ${target}, which Node refuses as a package target: a target starts with ./ and has no ., .. or node_modules segment after it` };
      }
      if (isInvalidModuleSpecifier(thrown)) {
        return { ok: false, error: `${name}'s export path ${exportPath} fills a pattern of exports with ${thrown.patternMatch}, which Node refuses: a pattern's match has no ., .. or node_modules segment` };
      }
      if (isInvalidPackageConfiguration(thrown)) return { ok: false, error: `${name}'s package.json exports ${thrown.reason}, which Node refuses as a package configuration` };
      throw thrown;
    }
    if (!resolution.listed) return { ok: false, error: noExportPath };
    const target = resolution.target;
    if (target === undefined) {
      return {
        ok: false,
        error: `${name}'s export path ${exportPath} is not exported to a host's import() under Node: it is null, or none of its node, import, module-sync or default conditions gives a target: add a \`default\` condition naming its JavaScript, which hosts load under Node and the catalogue build loads too`,
      };
    }
    // The package root, `.`, is the bare package name; any other export path is `<name>/<subpath>`.
    const specifier = exportPath === "." ? name : `${name}${exportPath.slice(1)}`;
    // The target as Node resolves it: a URL against the package's directory, refused with an encoded separator in its
    // path (finalizeResolution), then the file it names.
    const url = new URL(target, pathToFileURL(`${packageDir}/`));
    if (ENCODED_SEPARATOR.test(url.pathname)) {
      return { ok: false, error: `${specifier}'s target ${target} includes an encoded "/" or "\\" (%2F or %5C), which Node refuses: write the path's separators plainly` };
    }
    const file = fileURLToPath(url);
    if (!isWithin(packageDir, file)) return { ok: false, error: `${name}'s export path ${exportPath} names ${target}, which is not a file in the package at ${packageDir}: name the package's own JavaScript` };
    if (!existsSync(file)) return { ok: false, error: `${specifier}'s target ${target} does not exist in ${packageDir}: build the package first, so its export path's target exists` };
    if (statSync(file).isDirectory()) return { ok: false, error: `${specifier}'s target ${target} is a folder in ${packageDir}: name the built file itself` };
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
