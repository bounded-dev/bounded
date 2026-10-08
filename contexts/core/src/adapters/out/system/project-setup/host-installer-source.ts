// The host installers a project's installed packages offer: every dependency
// whose package.json exports `./host-installer`, or bundles one per host at
// `./hosts/<host>/host-installer` (as bounded does), is loaded from the
// project's node_modules, and its `hostInstaller` export parsed. The core
// names no host: any package that offers those export paths takes part
// (ADR 2026-015). Which bundled hosts run is the caller's choice.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HostInstaller, HostInstallerSource, HostInstallReport } from "bounded/application";
import type { Result } from "bounded/domain";

const EXPORT_PATH = "./host-installer";
/** A package bundling several hosts' adapters offers one installer per host here; the core names no host, only the pattern. */
const BUNDLED_EXPORT_PATH = /^\.\/hosts\/[^/]+\/host-installer$/;

/** The file an export path names: a path, or a conditional export's node (`default`) target. */
function targetOf(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (typeof target === "object" && target !== null && "default" in target && typeof target.default === "string") return target.default;
  return undefined;
}

type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

async function readJson(path: string): Promise<Result<Json>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false, error: `${path} is not a JSON object` };
  } catch (thrown) {
    return { ok: false, error: `${path} cannot be read: ${message(thrown)}` };
  }
}

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** A report as the installer gave it, checked: contributed code's output is parsed once, here. */
function parseReport(raw: unknown, packageName: string): Result<HostInstallReport> {
  if (!isRecord(raw) || typeof raw.host !== "string" || !isStringList(raw.changedPaths) || !(raw.skippedBecause === null || typeof raw.skippedBecause === "string")) {
    return { ok: false, error: `${packageName}'s host installer answered with something that is not a report` };
  }
  return { ok: true, value: { host: raw.host, changedPaths: [...raw.changedPaths], skippedBecause: raw.skippedBecause } };
}

function parseResult(raw: unknown, packageName: string): Result<HostInstallReport> {
  if (!isRecord(raw) || typeof raw.ok !== "boolean") return { ok: false, error: `${packageName}'s host installer answered with something that is not a result` };
  if (!raw.ok) return { ok: false, error: typeof raw.error === "string" ? raw.error : `${packageName}'s host installer failed without saying why` };
  return parseReport(raw.value, packageName);
}

/** The installer a module exports, checked, wrapped so its answers are checked too. */
function parseInstaller(module: unknown, packageName: string): Result<HostInstaller> {
  const exported = isRecord(module) ? module.hostInstaller : undefined;
  if (!isRecord(exported) || typeof exported.host !== "string" || typeof exported.install !== "function") {
    return { ok: false, error: `${packageName} exports ${EXPORT_PATH} without a hostInstaller ({ host, install }): reinstall ${packageName}, or report it to its maintainers` };
  }
  const { host } = exported;
  const install: (projectRoot: string) => unknown = exported.install.bind(exported);
  return {
    ok: true,
    value: {
      host,
      install: async (projectRoot) => {
        try {
          return parseResult(await install(projectRoot), packageName);
        } catch (thrown) {
          return { ok: false, error: `${packageName}'s host installer failed: ${message(thrown)}` };
        }
      },
    },
  };
}

export class NodeModulesHostInstallerSource implements HostInstallerSource {
  async load(projectRoot: string): Promise<Result<readonly HostInstaller[]>> {
    const manifest = await readJson(join(projectRoot, "package.json"));
    if (!manifest.ok) return { ok: false, error: `${manifest.error}. Install bounded and your host's adapter package in the project first, so it has a package.json listing them` };
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies"]) {
      const group = manifest.value[field];
      if (isRecord(group)) for (const name of Object.keys(group)) names.add(name);
    }
    const installers: HostInstaller[] = [];
    for (const packageName of [...names].sort()) {
      const packageDir = join(projectRoot, "node_modules", packageName);
      const installed = await readJson(join(packageDir, "package.json"));
      if (!installed.ok) return { ok: false, error: `${packageName} is a dependency but is not installed (${installed.error}): install the project's dependencies, then run this again` };
      const exports = installed.value.exports;
      if (!isRecord(exports)) continue;
      // A package's own installer, then those it bundles one per host, in export path order.
      const paths = Object.keys(exports)
        .filter((path) => path === EXPORT_PATH || BUNDLED_EXPORT_PATH.test(path))
        .sort((a, b) => (a === EXPORT_PATH ? -1 : b === EXPORT_PATH ? 1 : a.localeCompare(b)));
      for (const path of paths) {
        const target = targetOf(exports[path]);
        const from = path === EXPORT_PATH ? packageName : `${packageName}'s ${path}`;
        if (target === undefined) return { ok: false, error: `${packageName}'s ${path} export is not a file path` };
        let module: unknown;
        try {
          module = await import(pathToFileURL(join(packageDir, target)).href);
        } catch (thrown) {
          return { ok: false, error: `${from} host installer could not be loaded: ${message(thrown)}` };
        }
        const installer = parseInstaller(module, path === EXPORT_PATH ? packageName : `${packageName} (${path})`);
        if (!installer.ok) return installer;
        installers.push(installer.value);
      }
    }
    return { ok: true, value: installers };
  }
}
