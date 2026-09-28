// Writes a new project's package manifest and lockfile (ADR 2026-051).
//
// The project initializer runs this through the ts pack's
// `projectManifestScripts` contribution, as
// `node project-package.ts <project> <harness source root>`, after the core
// has written its own files. The package format belongs to this pack, never
// the core: the core only runs the script.
//
// Content comes from the project's composed packs' data: exactly one
// `projectPackageTemplate`, plus every pack's `projectScripts`, `pins` and
// `projectCheckScripts`. The same function is what `sync-config` rewrites and
// the phase gates' drift check compares against (ADR 2026-054).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMainModule } from "../../../src/is-main-module.ts";
import { contributionsByPack } from "../../../src/pack-contrib.ts";
import { readProjectPacks } from "../../../src/project-composition.ts";
import { lockFor, type RuntimePackage } from "../../../src/runtime-lock.ts";

type Pins = { dependencies?: unknown; devDependencies?: unknown };

export function mergeProjectFields(target: Record<string, string>, added: Record<string, string>, kind: string, pack: string): void {
  for (const [name, value] of Object.entries(added)) {
    const previous = Object.hasOwn(target, name) ? target[name] : undefined;
    if (previous !== undefined && previous !== value) {
      throw new Error(`${kind} '${name}' conflicts with capability '${pack}'`);
    }
    Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
  }
}

/** The project package the composed packs describe. */
export function packageFor(packs: readonly string[], packsDir: string): RuntimePackage {
  const templates = contributionsByPack("projectPackageTemplate", packs, packsDir);
  for (const { pack, value } of templates) {
    if (typeof value !== "string" || !/^[a-z0-9/-]+\.json$/.test(value) || value.includes("..")) {
      throw new Error(`Capability '${pack}' has an invalid projectPackageTemplate`);
    }
  }
  if (templates.length !== 1) throw new Error("Selected capabilities must provide exactly one project package template");
  const template = templates[0];
  const pkg = JSON.parse(readFileSync(join(packsDir, template.pack, template.value as string), "utf8")) as RuntimePackage;
  if (!pkg || typeof pkg !== "object" || !pkg.scripts || !pkg.dependencies || !pkg.devDependencies) {
    throw new Error(`Capability '${template.pack}' has an invalid project package template`);
  }
  const result: RuntimePackage = {
    name: "bounded-project", version: pkg.version ?? "0.1.0", private: true, type: "module",
    scripts: { ...pkg.scripts }, dependencies: { ...pkg.dependencies }, devDependencies: { ...pkg.devDependencies },
  };
  for (const { pack, value } of contributionsByPack("projectScripts", packs, packsDir)) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.values(value).some((command) => typeof command !== "string" || !command.trim())) {
      throw new Error(`Capability '${pack}' has invalid projectScripts`);
    }
    mergeProjectFields(result.scripts!, value as Record<string, string>, "Project script", pack);
  }
  for (const { pack, value } of contributionsByPack("pins", packs, packsDir)) {
    for (const kind of ["dependencies", "devDependencies"] as const) {
      const pins = (value as Pins)?.[kind];
      if (pins === undefined) continue;
      if (!pins || typeof pins !== "object" || Array.isArray(pins) ||
        Object.values(pins).some((version) => typeof version !== "string" || !version)) {
        throw new Error(`Capability '${pack}' has invalid ${kind} pins`);
      }
      mergeProjectFields(result[kind]!, pins as Record<string, string>, "Dependency", pack);
    }
  }
  // A pack may fold one of the scripts into the project's own `check`, in
  // composition order, the way deliver folds its checks (ADR 2026-054): the
  // generated manifest is then already the delivered one.
  for (const { pack, value } of contributionsByPack("projectCheckScripts", packs, packsDir)) {
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !Object.hasOwn(result.scripts!, name))) {
      throw new Error(`Capability '${pack}' has invalid projectCheckScripts: each must name a project script`);
    }
    for (const name of value as string[]) {
      const check = result.scripts!["check"];
      if (check === undefined) result.scripts!["check"] = `npm run ${name}`;
      else if (!check.includes(`run ${name}`)) result.scripts!["check"] = `${check} && npm run ${name}`;
    }
  }
  for (const name of Object.keys(result.dependencies!)) {
    if (name in result.devDependencies!) throw new Error(`Dependency '${name}' is both production and development`);
  }
  return result;
}

/** One file a composed pack ships verbatim to a fixed project path. */
export interface ShippedFile {
  readonly path: string;
  readonly source: string;
}

/**
 * The composed packs' `projectShippedFiles` (ADR 2026-054): project-relative
 * path → pack-relative source, copied byte for byte. The ts pack ships the
 * surface checker its generated `check:surface` script runs, so a new
 * project's check does not wait for delivery to ship it.
 */
export function shippedFiles(packs: readonly string[], packsDir: string): ShippedFile[] {
  const out: ShippedFile[] = [];
  const seen = new Set<string>();
  const safe = (path: unknown): path is string => typeof path === "string" &&
    /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(path) && !path.split("/").includes("..");
  for (const { pack, value } of contributionsByPack("projectShippedFiles", packs, packsDir)) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.entries(value).some(([path, source]) => !safe(path) || !safe(source))) {
      throw new Error(`Capability '${pack}' has invalid projectShippedFiles`);
    }
    for (const [path, source] of Object.entries(value as Record<string, string>)) {
      if (seen.has(path)) throw new Error(`Shipped file '${path}' conflicts with capability '${pack}'`);
      seen.add(path);
      out.push({ path, source: join(packsDir, pack, source) });
    }
  }
  return out;
}

/** Write the manifest, lockfile and shipped files into a freshly initialized project. */
export function writeProjectPackage(project: string, agentRoot: string): void {
  const packageFile = join(project, "package.json");
  if (existsSync(packageFile)) {
    throw new Error("A project initializer wrote package.json; package ownership belongs to selected capability manifests");
  }
  const pkg = packageFor(readProjectPacks(project), join(agentRoot, "packs"));
  writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(join(project, "package-lock.json"), JSON.stringify(lockFor(pkg, agentRoot), null, 2) + "\n");
  for (const { path, source } of shippedFiles(readProjectPacks(project), join(agentRoot, "packs"))) {
    const target = join(project, path);
    if (existsSync(target)) throw new Error(`A project initializer wrote ${path}; it belongs to a capability's shipped files`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

if (isMainModule(import.meta.url)) {
  const [project, agentRoot] = process.argv.slice(2);
  if (!project || !agentRoot) throw new Error("usage: project-package <project> <harness source root>");
  writeProjectPackage(resolve(project), resolve(agentRoot));
}
