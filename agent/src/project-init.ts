// Assemble a project-local harness from the installed, selected capabilities.
// Planning happens in an isolated tree; the target is untouched until the
// caller applies the digest of that exact plan.
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  contributionsByPack, mergedContribution, projectCommandNames, projectConfigSources,
  projectIgnoreRules, sourceRootOf, sourceRootsFor,
} from "./pack-contrib.ts";
import { COMPOSITION_FILE, writeProjectPacks } from "./project-composition.ts";
import { lockFor, sourceLockPath, type RuntimePackage } from "./runtime-lock.ts";
import { beforeFirstRun, HOST_PACKAGE_DIRS, SETUP_COMMAND } from "./setup-state.ts";
import {
  offeredSurfaces, selectForSurfaces, type SurfaceDecisions, type SurfacePack, type SurfaceSelection,
} from "./product-surfaces.ts";

export type InitHost = "pi" | "claude-code";
export interface InitPlan {
  readonly schemaVersion: 1;
  readonly host: InitHost;
  readonly packs: readonly string[];
  readonly version: string;
  readonly provenance: string;
  /** Every file in the reviewed initial write set. */
  readonly createdFiles: Readonly<Record<string, string>>;
  /** Installer-owned files only. Product files can change after init. */
  readonly files: Readonly<Record<string, string>>;
  /** The digest of the untouched installation this plan replaces, when it
   *  re-plans one before the first ticket (ADR 2026-065). */
  readonly replaces?: string;
  readonly digest: string;
}

const containingRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = basename(containingRoot) === "dist" ? resolve(containingRoot, "..") : containingRoot;
const sourceRoot = resolve(agentRoot, "..");
const MANIFEST = ".bounded/installation.json";

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertEmpty(target: string): void {
  if (!existsSync(target)) return;
  if (lstatSync(target).isSymbolicLink()) throw new Error("The target directory must not be a symlink");
  if (!statSync(target).isDirectory()) throw new Error(`'${target}' is not a directory`);
  const entries = readdirSync(target).filter((entry) => entry !== ".git");
  if (entries.length) throw new Error(`Bounded requires an empty directory (or only .git/); found: ${entries.join(", ")}`);
  if (existsSync(join(target, ".git")) && (!statSync(join(target, ".git")).isDirectory() || lstatSync(join(target, ".git")).isSymbolicLink())) {
    throw new Error(".git exists but is not a directory");
  }
}

function walk(root: string, base = ""): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`source contains a symlink: ${rel}`);
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else if (entry.isFile()) out.push(rel);
    else throw new Error(`source contains an unsupported entry: ${rel}`);
  }
  return out;
}

function copyTree(from: string, into: string, omit: (path: string) => boolean = () => false): void {
  for (const path of walk(from)) {
    if (omit(path)) continue;
    const dest = join(into, path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(from, path), dest);
  }
}

function sourceRelease(): { version: string; provenance: string } {
  const pkg = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8")) as { name: string; version: string };
  let provenance = `npm:${pkg.name}@${pkg.version}`;
  const buildInfo = join(agentRoot, "build-info.json");
  if (existsSync(buildInfo) && !existsSync(join(sourceRoot, "docs", "VISION.md"))) {
    const info = JSON.parse(readFileSync(buildInfo, "utf8")) as { commit: string; dirty: boolean };
    provenance = `${info.commit}${info.dirty ? "+working-tree" : ""}`;
  }
  if (basename(agentRoot) === "agent" && existsSync(join(sourceRoot, "docs", "VISION.md"))) try {
    provenance = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const changes = execFileSync("git", ["status", "--porcelain", "--", "agent"], { cwd: sourceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (changes) provenance += "+working-tree";
  } catch { /* A packaged CLI need not have a git checkout. */ }
  return { version: pkg.version, provenance };
}

function closure(names: readonly string[]): readonly string[] {
  if (!names.length) throw new Error("Select at least one capability with --pack");
  const known = availablePacks();
  const selected = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  const add = (name: string): void => {
    const pack = known.get(name);
    if (!pack) throw new Error(`Unknown capability '${name}'`);
    if (selected.has(name)) return;
    if (visiting.has(name)) throw new Error(`Capability dependency cycle at '${name}'`);
    visiting.add(name);
    pack.dependsOnPacks.forEach(add);
    visiting.delete(name);
    selected.add(name);
    order.push(name);
  };
  names.forEach(add);
  return order;
}

function availablePacks(): Map<string, SurfacePack & { dependsOnPacks: string[] }> {
  const known = new Map<string, SurfacePack & { dependsOnPacks: string[] }>();
  for (const entry of readdirSync(join(agentRoot, "packs"), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z][a-z0-9-]*$/.test(entry.name)) continue;
    const manifestPath = join(agentRoot, "packs", entry.name, "contrib.json");
    if (!existsSync(manifestPath) || !existsSync(join(agentRoot, "packs", entry.name, "pack.ts"))) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependsOnPacks?: unknown; productSurfaces?: unknown };
    const deps = manifest.dependsOnPacks ?? [];
    if (!Array.isArray(deps) || deps.some((x) => typeof x !== "string" || !/^[a-z][a-z0-9-]*$/.test(x))) {
      throw new Error(`Capability '${entry.name}' has invalid dependsOnPacks`);
    }
    const surfaces = manifest.productSurfaces ?? [];
    if (!Array.isArray(surfaces) || surfaces.some((x) => typeof x !== "string")) {
      throw new Error(`Capability '${entry.name}' has invalid productSurfaces`);
    }
    known.set(entry.name, { dependsOnPacks: deps, productSurfaces: surfaces });
  }
  return known;
}

/** A script-list socket's entries, in composition order. */
function packScripts(packs: readonly string[], key: string): { pack: string; script: string }[] {
  const scripts: { pack: string; script: string }[] = [];
  for (const pack of packs) {
    const raw = (JSON.parse(readFileSync(join(agentRoot, "packs", pack, "contrib.json"), "utf8")) as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string" || !/^scripts\/[a-z0-9-]+\.ts$/.test(s))) {
      throw new Error(`Capability '${pack}' has invalid ${key}`);
    }
    scripts.push(...raw.map((script: string) => ({ pack, script })));
  }
  return scripts;
}

/** A pack script run from the harness source: its compiled form when built. */
function packScriptEntry(pack: string, script: string): string {
  const bundled = join(agentRoot, "dist", "packs", pack, script.slice(0, -3) + ".js");
  return existsSync(bundled) ? bundled : join(agentRoot, "packs", pack, script);
}

/** The TN README's example `contracts:` entry: the paths the composed packs
 *  name for it (`tnExampleContracts`, in their own layout, placeholders in
 *  angle brackets). Each must lie under a composed source root (ADR 2026-056)
 *  and end with a composed contract suffix (ADR 2026-052), or init refuses.
 *  The core invents none: with no path named, the list is empty. */
export function exampleContracts(packs: readonly string[]): string[] {
  const packsDir = join(agentRoot, "packs");
  const suffixes = mergedContribution("contractFileSuffixes", packs, packsDir);
  const roots = sourceRootsFor(packs, packsDir);
  const named = contributionsByPack("tnExampleContracts", packs, packsDir).flatMap(({ pack, value }) => {
    if (!Array.isArray(value) || value.some((path) => typeof path !== "string")) {
      throw new Error(`Selected pack '${pack}' field 'tnExampleContracts' must be an array of paths`);
    }
    return value as string[];
  });
  for (const path of named) {
    if (sourceRootOf(path, roots) === undefined || !suffixes.some((s) => path.endsWith(s))) {
      throw new Error(`tnExampleContracts entry '${path}' is not a contract file under a composed source root`);
    }
  }
  return named.length === 0 ? ["contracts: []"] : ["contracts:", ...[...new Set(named)].map((path) => `  - ${path}`)];
}

/** The TN README's example `workspaces:` block: the apps the composed packs
 *  can make (`tnExampleWorkspaces`), in the block form ticket design accepts
 *  (TN-26-012 section 9), sorted by directory. None when no pack makes one. */
export function exampleWorkspaces(packs: readonly string[]): string[] {
  const entries = new Map<string, string>();
  for (const { pack, value } of contributionsByPack("tnExampleWorkspaces", packs, join(agentRoot, "packs"))) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Selected pack '${pack}' field 'tnExampleWorkspaces' must be an object`);
    }
    for (const [dir, kind] of Object.entries(value as Record<string, unknown>)) {
      if (!/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/.test(dir) || typeof kind !== "string" ||
          !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(kind) || entries.has(dir)) {
        throw new Error(`Selected pack '${pack}' has an invalid tnExampleWorkspaces entry '${dir}'`);
      }
      entries.set(dir, kind);
    }
  }
  if (entries.size === 0) return [];
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return ["workspaces:", ...sorted.map(([dir, kind]) => `  ${dir}: ${kind}`)];
}

/** Where the default selection is recorded: pack-side data, so the core names
 *  no technology. */
export const DEFAULT_STACK_FILE = "default-stack.json";

/** The selection `bounded init` makes when none is named: the explicit list in
 *  `packs/default-stack.json`, in its own order. Every name must be an
 *  available pack; a name that is not is refused rather than skipped. */
export function defaultSelection(): readonly string[] {
  const raw = JSON.parse(readFileSync(join(agentRoot, "packs", DEFAULT_STACK_FILE), "utf8")) as { packs?: unknown };
  const packs = raw.packs;
  if (!Array.isArray(packs) || packs.length === 0 || packs.some((p) => typeof p !== "string")) {
    throw new Error(`packs/${DEFAULT_STACK_FILE} must list at least one pack name`);
  }
  const known = availablePacks();
  const unknown = (packs as string[]).filter((p) => !known.has(p));
  if (unknown.length) throw new Error(`packs/${DEFAULT_STACK_FILE} names packs that are not installed: ${unknown.join(", ")}`);
  return packs as string[];
}

/** A closed selection in the default stack's order where that order respects
 *  every dependency, so the same surfaces give the same plan however the
 *  agent listed them. Packs outside the default stack follow, by name. */
function canonicalClosure(names: readonly string[]): readonly string[] {
  const closed = closure(names);
  const stack = defaultSelection();
  const rank = (name: string): number => (stack.includes(name) ? stack.indexOf(name) : stack.length);
  const ordered = [...closed].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const known = availablePacks();
  const respectsDependencies = ordered.every((name, i) =>
    known.get(name)!.dependsOnPacks.every((dep) => ordered.indexOf(dep) < i));
  return respectsDependencies ? ordered : closed;
}

/** The selection for the product surfaces the spec and the user decided
 *  (ADR 2026-065), from the installed packs' `productSurfaces` data. */
export function surfaceSelection(decisions: SurfaceDecisions, explicitPacks: readonly string[] = []): SurfaceSelection {
  return selectForSurfaces(decisions, availablePacks(), canonicalClosure, explicitPacks);
}

/** The project's name, from its directory's name: lowercase letters, digits
 *  and dashes. Undefined when nothing usable is left, so the manifest writer
 *  falls back to its own default. */
export function projectNameOf(target: string): string | undefined {
  const candidate = basename(resolve(target)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9][a-z0-9-]*$/.test(candidate) ? candidate : undefined;
}

/** A pack that says so explicitly, with an empty `projectInitScripts` list,
 *  has nothing to scaffold at init: its files are shipped config or come from
 *  the design later. Omitting the field is not that declaration. */
export function declaresNoInitializer(pack: string): boolean {
  const raw = JSON.parse(readFileSync(join(agentRoot, "packs", pack, "contrib.json"), "utf8")) as Record<string, unknown>;
  const scripts = raw["projectInitScripts"];
  return Array.isArray(scripts) && scripts.length === 0;
}

function scaffolderFor(packs: readonly string[]): readonly { pack: string; script: string }[] {
  const scripts = packScripts(packs, "projectInitScripts");
  const covered = new Set<string>(scripts.map(({ pack }) => pack));
  const byName = availablePacks();
  const visit = (name: string): void => {
    for (const dep of byName.get(name)?.dependsOnPacks ?? []) {
      if (covered.has(dep)) continue;
      covered.add(dep);
      visit(dep);
    }
  };
  for (const { pack } of scripts) visit(pack);
  // A pack that declares it has nothing to scaffold (its files are shipped
  // config, or come from the design later) covers itself and what it builds
  // on, so a persistence-only or contexts-only selection is complete.
  for (const pack of packs) {
    if (!declaresNoInitializer(pack)) continue;
    covered.add(pack);
    visit(pack);
  }
  const unsupported = packs.filter((pack) => !covered.has(pack));
  if (scripts.length === 0 && (unsupported.length > 0 || packs.length === 0)) {
    throw new Error("This selection cannot yet scaffold a complete new project; choose a capability with a project initializer");
  }
  if (unsupported.length) throw new Error(`No new-project initializer covers: ${unsupported.join(", ")}`);
  return scripts;
}

function writeSelectedRegistry(harnessRoot: string, packs: readonly string[]): void {
  const imports = packs.map((pack, i) => {
    const source = readFileSync(join(agentRoot, "packs", pack, "pack.ts"), "utf8");
    const match = source.match(/export const ([A-Za-z][A-Za-z0-9]*)\s*=\s*definePack\(/);
    if (!match) throw new Error(`Capability '${pack}' has no exported pack definition`);
    return { pack, symbol: match[1], alias: `selectedPack${i}` };
  });
  const body = [
    '// Generated for this project by bounded init. Only selected capabilities are imported.',
    'import { composePacks } from "../src/socket-registry.ts";',
    'import { readProjectPacks } from "../src/project-composition.ts";',
    ...imports.map((x) => `import { ${x.symbol} as ${x.alias} } from "./${x.pack}/pack.ts";`),
    `export const INSTALLED_PACKS = Object.freeze([${imports.map((x) => x.alias).join(", ")}]);`,
    'export function installedPacks() { return composePacks(INSTALLED_PACKS); }',
    'export function composedPacks(cwd: string) { return composePacks(INSTALLED_PACKS, readProjectPacks(cwd)); }',
    '',
  ].join("\n");
  writeFileSync(join(harnessRoot, "packs", "installed.ts"), body);
}

/** Harness pack paths as a role in the project sees them. The briefs and
 *  skills name a pack file harness-relative (`packs/ts-hexagonal/reference/`);
 *  in an initialized project the harness is `.bounded/harness/`. */
export function localPackPaths(text: string): string {
  return text.replace(/`packs\//g, "`.bounded/harness/packs/");
}

function localizeInstructions(harnessRoot: string, host: InitHost): void {
  // Skills are read by the host in the project root. A fresh clone does not
  // have a global `bounded` executable, so shell examples must use its copy.
  for (const directory of ["skills", "packs"]) {
    for (const path of walk(join(harnessRoot, directory)).filter((path) => path.endsWith(".md"))) {
      const absolute = join(harnessRoot, directory, path);
      const original = readFileSync(absolute, "utf8");
      let rendered = original
        .replace(/with `bounded compose[^`]+`/g, "during initialization")
        .replace(/using `bounded compose[^`]+` \(also select\n[^\n]+\)/g, "during initialization")
        .replace(/`bounded compose[^`]+`/g, "the committed capability selection from initialization")
        .replace(/\bbounded (change-run|adopt|change-diff|capture-baseline|sync-config|handoff|ticket|lead)\b/g, "bash .bounded/harness/scripts/bounded $1");
      rendered = localPackPaths(rendered);
      if (host === "pi" || path === "team-lead/SKILL.md") {
        rendered = rendered.replace(/\bbounded gates\b/g, "bash .bounded/harness/scripts/bounded gates");
      }
      if (rendered !== original) writeFileSync(absolute, rendered);
    }
  }
}

function localizeRoleSources(harnessRoot: string, host: InitHost): void {
  for (const path of walk(join(harnessRoot, "agents")).filter((path) => path.endsWith(".md"))) {
    const absolute = join(harnessRoot, "agents", path);
    const original = readFileSync(absolute, "utf8");
    let rendered = original.replace(/\bbounded change-run\b/g, "bash .bounded/harness/scripts/bounded change-run");
    rendered = localPackPaths(rendered);
    if (host === "pi") rendered = rendered.replace(/~\/\.pi\/agent\/hosts\/pi\/extensions\/path-gate\//g,
      "./.bounded/harness/hosts/pi/extensions/path-gate/");
    else rendered = rendered.replace(/^subagentOnlyExtensions: ~\/\.pi\/agent\/[^\n]+\n/gm, "");
    if (rendered !== original) writeFileSync(absolute, rendered);
  }
}

function localizeGeneratedRoles(stage: string, host: InitHost): void {
  const directory = join(stage, host === "pi" ? ".pi/agents" : ".claude/agents");
  for (const path of walk(directory).filter((path) => path.endsWith(".md"))) {
    const absolute = join(directory, path);
    const original = readFileSync(absolute, "utf8");
    let rendered = original.replace(/\bbounded change-run\b/g, "bash .bounded/harness/scripts/bounded change-run");
    rendered = localPackPaths(rendered);
    if (host === "pi") rendered = rendered.replace(/\bbounded gates\b/g, "bash .bounded/harness/scripts/bounded gates");
    if (rendered !== original) writeFileSync(absolute, rendered);
  }
}

function copyProjectConfigs(stage: string, packs: readonly string[]): void {
  for (const { pack, source, target } of projectConfigSources(packs, join(agentRoot, "packs"))) {
    const dest = join(stage, target);
    if (!existsSync(source) || existsSync(dest)) throw new Error(`Project config collision or missing source: ${pack}/${target}`);
    copyFileSync(source, dest);
  }
}

/** The source with every template literal's text blanked (line breaks kept).
 *  Emitters hold whole generated files in template literals, and the import
 *  lines inside them are the generated project's dependencies, not the
 *  harness's. Strings and comments are skipped so a backtick in them does not
 *  open a template. */
export function withoutTemplateText(source: string): string {
  const out: string[] = [];
  const braces: number[] = []; // per open `${`, the brace depth when it opened
  let depth = 0;
  let i = 0;
  const blank = (ch: string): string => (ch === "\n" ? "\n" : " ");
  const template = (): void => {
    // At the character after an opening backtick or a closing `}` of `${…}`.
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === "\\") { out.push(" ", blank(source[i + 1] ?? "")); i += 2; continue; }
      if (ch === "`") { out.push("`"); i++; return; }
      if (ch === "$" && source[i + 1] === "{") { out.push("${"); i += 2; braces.push(depth); depth++; return; }
      out.push(blank(ch)); i++;
    }
  };
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out.push(source.slice(i, stop)); i = stop; continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out.push(source.slice(i, stop)); i = stop; continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      out.push(source.slice(i, j + 1)); i = j + 1; continue;
    }
    if (ch === "`") { out.push("`"); i++; template(); continue; }
    if (ch === "{") { depth++; out.push(ch); i++; continue; }
    if (ch === "}") {
      depth--;
      out.push(ch); i++;
      if (braces.length > 0 && braces[braces.length - 1] === depth) { braces.pop(); template(); }
      continue;
    }
    out.push(ch); i++;
  }
  return out.join("");
}

/** A pack's runtime's own modules (`runtimeBuiltinModules`): each entry is
 *  a module name, or a scheme ending in `:` that covers every specifier
 *  starting with it. The core names only its own runtime's (`node:`). */
export function runtimeBuiltinModules(packs: readonly string[], packsDir = join(agentRoot, "packs")): string[] {
  return contributionsByPack("runtimeBuiltinModules", packs, packsDir).flatMap(({ pack, value }) => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !/^[a-z][a-z0-9-]*:?$/.test(entry))) {
      throw new Error(`Pack '${pack}' field 'runtimeBuiltinModules' must be an array of module names or schemes ending in ':'`);
    }
    return value as string[];
  });
}

/** Is `specifier` one of the runtimes' builtins: the core's own (`node:`) or
 *  one a pack declares in `runtimeBuiltinModules`? */
function isBuiltin(specifier: string, builtins: readonly string[]): boolean {
  if (specifier.startsWith("node:")) return true;
  return builtins.some((entry) => (entry.endsWith(":") ? specifier.startsWith(entry) : specifier === entry));
}

/** The packages a harness source file imports: bare specifiers reduced to
 *  their package name. Relative and absolute paths, and the runtimes' own
 *  builtins (`node:*`, and every pack's `runtimeBuiltinModules`), are no
 *  package the harness depends on. Template-literal text (generated files)
 *  is ignored. */
export function importedPackageNames(source: string, builtins: readonly string[] = []): string[] {
  const names = new Set<string>();
  const imports = withoutTemplateText(source).matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[^;\n]*?\s+from\s+)?["']([^"']+)["']/gm);
  for (const match of imports) {
    const specifier = match[1]!;
    if (specifier.startsWith(".") || specifier.startsWith("/") || isBuiltin(specifier, builtins)) continue;
    if (!/^(@[a-z0-9-]+\/[a-z0-9._-]+|[a-z0-9._-]+)/i.test(specifier)) continue;
    names.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!);
  }
  return [...names].sort();
}

function harnessPackageFor(harnessRoot: string): RuntimePackage {
  const sourcePkg = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8")) as RuntimePackage;
  const sourceLock = JSON.parse(readFileSync(sourceLockPath(agentRoot), "utf8")) as { packages: Record<string, { version?: string }> };
  const names = new Set<string>();
  const builtins = runtimeBuiltinModules([...availablePacks().keys()]);
  // A pack's reference/ files are content copied into projects, never harness
  // code: their imports are the project's dependencies, not the runtime's.
  for (const path of walk(harnessRoot).filter((path) => path.endsWith(".ts") && !/^packs\/[^/]+\/reference\//.test(path))) {
    for (const name of importedPackageNames(readFileSync(join(harnessRoot, path), "utf8"), builtins)) names.add(name);
  }
  const dependencies: Record<string, string> = {};
  for (const name of [...names].sort()) {
    if (!sourcePkg.dependencies?.[name] && !sourcePkg.devDependencies?.[name]) {
      throw new Error(`Copied harness imports undeclared package '${name}'`);
    }
    const version = sourceLock.packages[`node_modules/${name}`]?.version;
    if (!version) throw new Error(`Source lock has no version for copied harness dependency '${name}'`);
    dependencies[name] = version;
  }
  return {
    name: "bounded-project-harness", version: sourcePkg.version, private: true, type: "module",
    scripts: { check: "node ./src/gates-cli.ts --list" }, dependencies, devDependencies: {},
  };
}

async function assemble(stage: string, host: InitHost, packs: readonly string[], name: string | undefined): Promise<void> {
  const harnessRoot = join(stage, ".bounded", "harness");
  mkdirSync(harnessRoot, { recursive: true });
  const omit = (path: string): boolean => /(^|\/)(?:node_modules|testdata)(\/|$)/.test(path) || /(?:^|\.)test\.ts$/.test(path) ||
    path === "project-init.ts" || path === "project-init-cli.ts";
  copyTree(join(agentRoot, "src"), join(harnessRoot, "src"), omit);
  copyTree(join(agentRoot, "skills"), join(harnessRoot, "skills"), omit);
  copyTree(join(agentRoot, "agents"), join(harnessRoot, "agents"), omit);
  mkdirSync(join(harnessRoot, "scripts"), { recursive: true });
  for (const script of ["bounded-gates", "bounded-change-run", "bounded-handoff", "bounded-ticket"]) {
    copyFileSync(join(agentRoot, "scripts", script), join(harnessRoot, "scripts", script));
  }
  const gatesScript = join(harnessRoot, "scripts", "bounded-gates");
  writeFileSync(gatesScript, readFileSync(gatesScript, "utf8").replace(
    "reached directly or through the ~/.pi/agent symlink.",
    "reached through this project's local command.",
  ));
  const localCommand = join(harnessRoot, "scripts", "bounded");
  const coreCommands: readonly (readonly [string, string])[] = [
    ["gates", 'exec "$DIR/bounded-gates" "$@"'],
    ["handoff", 'exec "$DIR/bounded-handoff" "$@"'],
    ["ticket", 'exec "$DIR/bounded-ticket" "$@"'],
    ["change-run", 'exec "$DIR/bounded-change-run" "$@"'],
    ["lead", 'exec node "$DIR/../src/lead-cli.ts" "$@"'],
    ["setup", 'exec node "$DIR/../src/setup-state.ts" "$@"'],
  ];
  // The pack commands are whatever the composed packs declare: the core
  // names none of them, and an uncomposed pack's command is not reachable.
  const packCommands = projectCommandNames(packs, coreCommands.map(([name]) => name), join(agentRoot, "packs"));
  writeFileSync(localCommand, [
    "#!/usr/bin/env bash", "# Project-local Bounded command. Uses only this repository's harness.",
    "set -euo pipefail", 'DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'SUB="${1:-}"', 'case "$SUB" in',
    ...coreCommands.map(([name, run]) => `  ${name}) shift; ${run} ;;`),
    ...(packCommands.length > 0 ? [`  ${packCommands.join("|")}) shift; exec node "$DIR/../packs/command.ts" "$SUB" "$@" ;;`] : []),
    `  *) echo "bounded: supported project commands: ${[...coreCommands.map(([name]) => name), ...packCommands].join(", ")}" >&2; exit 64 ;;`,
    'esac', '',
  ].join("\n"));
  chmodSync(localCommand, 0o755);
  mkdirSync(join(harnessRoot, "packs"), { recursive: true });
  copyFileSync(join(agentRoot, "packs", "command.ts"), join(harnessRoot, "packs", "command.ts"));
  copyTree(join(agentRoot, "hosts", host), join(harnessRoot, "hosts", host), (path) => omit(path) || path === "README.md");
  // A pack's reference/ tree is a worked example the role briefs point at,
  // tests included: its test files are content to copy the shape of, not
  // harness tests, so they ship. They sit under .bounded/, which is in no
  // source root and which `bun test` skips as a hidden directory, so they
  // never count as the project's tests.
  const omitFromPack = (path: string): boolean =>
    path.startsWith("reference/") ? /(^|\/)(?:node_modules|testdata)(\/|$)/.test(path) : omit(path);
  for (const pack of packs) copyTree(join(agentRoot, "packs", pack), join(harnessRoot, "packs", pack), omitFromPack);
  localizeInstructions(harnessRoot, host);
  writeSelectedRegistry(harnessRoot, packs);
  const harnessPkg = harnessPackageFor(harnessRoot);
  writeFileSync(join(harnessRoot, "package.json"), JSON.stringify(harnessPkg, null, 2) + "\n");
  writeFileSync(join(harnessRoot, "package-lock.json"), JSON.stringify(lockFor(harnessPkg, agentRoot), null, 2) + "\n");
  writeProjectPacks(stage, packs);
  // Pack reference config lands before any initializer runs, so a generator
  // that also emits one of these files finds it already byte-identical.
  copyProjectConfigs(stage, packs);
  for (const { pack, script } of scaffolderFor(packs)) {
    const bundled = join(agentRoot, "dist", "packs", pack, script.slice(0, -3) + ".js");
    const entry = existsSync(bundled) ? bundled : join(harnessRoot, "packs", pack, script);
    execFileSync("node", [entry, stage], { stdio: "pipe" });
  }
  if (existsSync(join(stage, "AGENTS.md")) || existsSync(join(stage, "README.md"))) {
    throw new Error("A project initializer wrote root instructions; Bounded owns AGENTS.md and README.md during initialization");
  }
  mkdirSync(join(stage, "docs", "tn"), { recursive: true });
  writeFileSync(join(stage, "docs", "tn", "README.md"), [
    "# Technical Notes", "",
    "A ticket may have one Technical Note. The lead selects its number from an existing issue tracker when available, or allocates a local number in a new project.",
    "Name it `TN-<ticket-number>.md` and keep that name as the thinking matures.",
    "Use front matter with `issue`, `status` (`draft`, `active`, or `superseded`),",
    "and `contracts`, a list of project-relative contract files this ticket owns.",
    ...(exampleWorkspaces(packs).length > 0
      ? ["A ticket that needs an app declares it in a `workspaces:` block, one `<directory>: <kind>` per line."]
      : []),
    "A dependent ticket needs a reviewed, frozen TN before its design is published.",
    "The team lead selects the ticket for this worktree before the architect starts; existing direct launchers may set `BOUNDED_TICKET` explicitly.",
    "Change `status: draft` to `status: active` when the reviewed design is agreed;",
    "the design gate will not freeze a draft note.",
    "A superseded TN uses a Markdown link such as `[TN-25](TN-25.md)` to each",
    "successor note; other tickets may have no TN.", "",
    "Example front matter for issue 24:", "",
    "```yaml", "---", "issue: 24", "status: draft",
    ...exampleContracts(packs), ...exampleWorkspaces(packs), "---", "```", "",
  ].join("\n"));
  writeFileSync(join(stage, "AGENTS.md"), [
    "# Project agent instructions", "",
    "This project includes its own Bounded harness at `.bounded/harness/`.",
    "Initialization uses the agent host already running. For later requests, the main conversation is the team lead: discuss the user's goal, inspect the project, and delegate each ticket to a bound architect. The team lead does not edit product files. A read-only scout can investigate first. The architect runs the existing design, review, test, build, and delivery loop, even for one ticket.",
    "The user only needs to describe the product change. Select and prepare the ticket through the local lead workflow; do not ask the user to choose roles or run gate commands.",
    host === "pi" ? "Before commissioning the architect, call `lead_prepare`. Use its `new` option for a new work item after delivery; otherwise it resumes or changes the selected ticket." : "Before commissioning the architect, run `bash .bounded/harness/scripts/bounded lead prepare`, adding `--new` for a new work item after delivery. Then delegate to the generated architect agent as an ordinary foreground subagent without a name; it runs the existing loop through nested subagents.",
    "Run the project's `check`, `test`, `build`, and `lint` commands when present through the role that owns them.",
    host === "pi" ? "After a fresh clone, the team lead calls `lead_setup` before the first run; reload the session afterwards to load the full gates." : `After a fresh clone, the team lead runs \`${SETUP_COMMAND}\` before the first run; the next hook call loads the full gates.`,
    "Use `bash .bounded/harness/scripts/bounded gates --list` to discover the local gates.",
    "The architect owns `docs/tn/TN-<ticket-number>.md` and its contract paths. The lead selects the current ticket for this worktree before delegation.",
    `Selected capabilities: ${packs.join(", ")}.`, "",
  ].join("\n"));
  if (host === "pi") {
    const { installProjectPi } = await import("../hosts/pi/project-install.ts");
    installProjectPi(stage, harnessRoot);
  } else {
    const { installProjectClaude } = await import("../hosts/claude-code/project-install.ts");
    installProjectClaude(stage, harnessRoot);
  }
  localizeRoleSources(harnessRoot, host);
  localizeGeneratedRoles(stage, host);
  // The project's own build manifests (its package file and lockfile, say)
  // are pack content: the core only runs each pack's contributed writer.
  for (const { pack, script } of packScripts(packs, "projectManifestScripts")) {
    // The project's name (its directory's) is the third argument: the staging
    // directory's own name is random, and the name becomes the package scope.
    execFileSync("node", [packScriptEntry(pack, script), stage, agentRoot, ...(name === undefined ? [] : [name])], { stdio: "pipe" });
  }
  writeFileSync(join(stage, "README.md"), [
    "# New Bounded project", "",
    "This repository contains its own Bounded harness under `.bounded/harness/`.",
    `Selected capabilities: ${packs.join(", ")}. Agent host: ${host}.`, "",
    "## After cloning", "",
    "Open this directory in its selected agent host and describe the product change. The team lead handles the ticket and setup. On a fresh clone it installs the project and harness dependencies from their committed lockfiles before starting the gated work.",
    "Run `bash .bounded/harness/scripts/bounded gates --list` to confirm the local gate command is available.",
    "The product's `check` command becomes meaningful as the first feature is designed and built.", "",
  ].join("\n"));
  const ignoreFile = join(stage, ".gitignore");
  const existingIgnore = existsSync(ignoreFile) ? readFileSync(ignoreFile, "utf8").trimEnd() + "\n" : "";
  // Selected capabilities name what their setup and builds produce; the core
  // names only its own state and the harness's own runtime install. The
  // lockfile fingerprint is committed state: it records the clean resolution
  // the committed lockfile must match, so a fresh clone can verify it.
  const rules = [...projectIgnoreRules(packs, join(agentRoot, "packs")), ...HOST_PACKAGE_DIRS.map((dir) => `${dir}/`),
    ".bounded/*", "!.bounded/harness/", ".bounded/harness/node_modules/", "!.bounded/composed-packs.json", "!.bounded/installation.json",
    "!.bounded/lockfile-fingerprint.json"];
  writeFileSync(ignoreFile, existingIgnore + rules.filter((rule) => !existingIgnore.split("\n").includes(rule)).join("\n") + "\n");
}

function fileHashes(stage: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of walk(stage).sort()) {
    if (path === MANIFEST || path.startsWith(".bounded/guard-") || path.startsWith(".bounded/run-")) continue;
    files[path] = sha(readFileSync(join(stage, path)));
  }
  return files;
}

function planFromStage(stage: string, host: InitHost, packs: readonly string[], replaces?: string): InitPlan {
  const release = sourceRelease();
  const createdFiles = fileHashes(stage);
  const files = Object.fromEntries(Object.entries(createdFiles).filter(([path]) =>
    path.startsWith(".bounded/harness/") || path === COMPOSITION_FILE ||
    path === "AGENTS.md" || path === "CLAUDE.md" || path.startsWith(".claude/") || path.startsWith(".pi/"),
  ));
  const content = { schemaVersion: 1 as const, host, packs, ...release, createdFiles, files, ...(replaces !== undefined ? { replaces } : {}) };
  return { ...content, digest: sha(JSON.stringify(content)) };
}

const safeManifestPath = (path: string): boolean => /^[a-zA-Z0-9._/-]+$/.test(path) && !path.includes("..") && !path.startsWith("/");

/** The recorded installation, its digest and paths checked; none when absent. */
function readInstallation(target: string): InitPlan | undefined {
  const manifest = join(target, MANIFEST);
  if (!existsSync(manifest)) return undefined;
  const previous = JSON.parse(readFileSync(manifest, "utf8")) as InitPlan;
  if (previous.schemaVersion !== 1 || !previous.files || !previous.createdFiles || typeof previous.digest !== "string" ||
      !Array.isArray(previous.packs)) {
    throw new Error("Installation manifest is invalid or changed");
  }
  const { digest: _digest, ...content } = previous;
  if (sha(JSON.stringify(content)) !== previous.digest) throw new Error("Installation manifest is invalid or changed");
  if (![...Object.keys(previous.files), ...Object.keys(previous.createdFiles)].every(safeManifestPath)) {
    throw new Error("Installation manifest contains an unsafe path");
  }
  return previous;
}

type Existing =
  | { readonly kind: "same"; readonly plan: InitPlan }
  | { readonly kind: "replace"; readonly previous: InitPlan; readonly setupOutput: readonly string[] };

/** The installation already in `target`: the same selection (its installer
 *  files must be intact; product edits are fine), or one this selection may
 *  replace because nothing has happened since it was made. */
function existingInstallation(target: string, host: InitHost, packs: readonly string[]): Existing | undefined {
  const previous = readInstallation(target);
  if (previous === undefined) return undefined;
  if (previous.host === host && JSON.stringify(previous.packs) === JSON.stringify(packs)) {
    for (const [path, hash] of Object.entries(previous.files)) {
      const absolute = join(target, path);
      if (!existsSync(absolute) || !lstatSync(absolute).isFile() || sha(readFileSync(absolute)) !== hash) {
        throw new Error(`Installed file changed: ${path}; bounded update is required`);
      }
    }
    return { kind: "same", plan: previous };
  }
  const replaceable = replanBlocker(target, previous);
  if (typeof replaceable === "string") {
    throw new Error(`Existing installation differs from this selection and cannot be re-planned: ${replaceable}; bounded update is required`);
  }
  return { kind: "replace", previous, setupOutput: replaceable.setupOutput };
}

/** A matcher for root-anchored ignore rules, one path segment at a time:
 *  the walk below stops at the first ignored directory. */
function ignoreMatcher(rules: readonly string[]): (path: string) => boolean {
  const escape = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const patterns = rules.map((rule) => rule.replace(/^\/+|\/+$/g, "").split("/")
    .map((segment) => new RegExp(`^${segment.split("*").map(escape).join("[^/]*")}$`)));
  return (path) => {
    const parts = path.split("/");
    return patterns.some((pattern) => pattern.length === parts.length && pattern.every((re, i) => re.test(parts[i]!)));
  };
}

/**
 * Why the installation cannot be re-planned, or what setup produced in it.
 * Re-planning replaces the whole installation, so it is allowed only while
 * the project is exactly what init made: no ticket prepared or run, every
 * file init created unchanged, and nothing added except what setup and the
 * host produce (the installation's own ignore rules) and `.bounded/` state.
 */
function replanBlocker(target: string, previous: InitPlan): string | { readonly setupOutput: readonly string[] } {
  if (!beforeFirstRun(target)) return "a ticket has already been prepared or run here";
  for (const [path, hash] of Object.entries(previous.createdFiles)) {
    const absolute = join(target, path);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile() || sha(readFileSync(absolute)) !== hash) {
      return `${path} changed since initialization`;
    }
  }
  let ignored: (path: string) => boolean;
  try {
    ignored = ignoreMatcher([
      ...projectIgnoreRules(previous.packs, join(target, ".bounded", "harness", "packs")),
      ...HOST_PACKAGE_DIRS.map((dir) => `/${dir}/`),
    ]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const extra: string[] = [];
  const setupOutput: string[] = [];
  const visit = (base: string): void => {
    for (const entry of readdirSync(join(target, base), { withFileTypes: true })) {
      if (base === "" && (entry.name === ".git" || entry.name === ".bounded")) continue;
      const path = base ? `${base}/${entry.name}` : entry.name;
      if (ignored(path)) setupOutput.push(path);
      else if (entry.isDirectory()) visit(path);
      else if (!Object.hasOwn(previous.createdFiles, path)) extra.push(path);
    }
  };
  visit("");
  if (extra.length > 0) {
    return `files were added since initialization (${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", ..." : ""})`;
  }
  return { setupOutput };
}

/** Remove every empty directory below `root`, deepest first, leaving .git alone. */
function pruneEmptyDirectories(root: string, base = ""): void {
  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    if (!entry.isDirectory() || (base === "" && entry.name === ".git")) continue;
    const path = base ? `${base}/${entry.name}` : entry.name;
    pruneEmptyDirectories(root, path);
    if (readdirSync(join(root, path)).length === 0) rmSync(join(root, path), { recursive: true });
  }
}

/** Take the untouched installation out of `target`, keeping a copy of every
 *  file it created so a failed replacement can put it back. Setup output and
 *  `.bounded/` state are not kept: setup runs again for the new selection. */
function removeInstallation(target: string, existing: Extract<Existing, { kind: "replace" }>): { restore(): void; discard(): void } {
  const backup = mkdtempSync(join(tmpdir(), "bounded-init-replaced-"));
  const created = Object.keys(existing.previous.createdFiles);
  for (const path of [...created, MANIFEST]) {
    mkdirSync(dirname(join(backup, path)), { recursive: true });
    copyFileSync(join(target, path), join(backup, path));
  }
  rmSync(join(target, ".bounded"), { recursive: true, force: true });
  for (const path of existing.setupOutput) rmSync(join(target, path), { recursive: true, force: true });
  for (const path of created) rmSync(join(target, path), { force: true });
  pruneEmptyDirectories(target);
  return {
    restore: () => copyTree(backup, target),
    discard: () => rmSync(backup, { recursive: true, force: true }),
  };
}

export function describeInit(): object {
  const available = availablePacks();
  return {
    command: "bounded init", writes: false,
    agentConversation: {
      openingRequest: "Please share your product spec or requirements: paste the text, or give the path to a file that holds them.",
      guidance: [
        "Start from the product spec, before any question about the kind of application. Ask for it pasted, or for the path to a file, and read that file. If the user has only a short description, that description is the spec.",
        "Map the spec privately to the product surfaces below. For each, decide whether the spec says the product needs it, says it does not, or leaves it open. A spec that names a way the product is used (a web app, a desktop app, AI assistants using it, a job on a timer, other programs calling it, data that must be kept) needs that surface. A spec that lists where the product is used and leaves a surface out declines it.",
        "Ask the user only about the surfaces the spec leaves open, using each one's question in plain language. Do not ask the user to choose pack names or present the capabilities as a menu.",
        "Run bounded init --host <current-host> with --surface <id> for every needed surface and --without <id> for every declined one. Init selects the capabilities from the packs' own data. If it answers with open surfaces, ask their questions and run it again with the answers.",
        "Use the agent host already running this conversation; do not ask the user to select another agent.",
        "If the complete application cannot be scaffolded, explain the gap in product terms and stop. Do not silently omit a required part of the application.",
        "When a complete plan succeeds, explain what Bounded will create in plain language and review the plan before applying its digest.",
        "Until the first ticket is prepared, the selection can be corrected from inside the project: run bounded init again with the corrected surfaces, and the plan replaces the untouched installation.",
      ],
    },
    hosts: ["pi", "claude-code"],
    productSurfaces: offeredSurfaces(available).map((surface) => ({
      ...surface, servedBy: [...available].filter(([, pack]) => pack.productSurfaces.includes(surface.id)).map(([name]) => name),
    })),
    defaultSelection: defaultSelection(),
    implementationOptions: [...available].map(([name, pack]) => ({ name, requires: pack.dependsOnPacks, hasProjectInitializer: scaffolderAvailable(name) })),
    next: "Ask for the product spec first. Then run bounded init --host <current-host> --surface <id> [--surface <id>...] [--without <id>...] to validate and review a plan. --pack <capability> remains for people who already know the capabilities they want; omitting both selects defaultSelection, the whole stack.",
  };
}

function scaffolderAvailable(pack: string): boolean {
  const raw = JSON.parse(readFileSync(join(agentRoot, "packs", pack, "contrib.json"), "utf8")) as { projectInitScripts?: unknown };
  return Array.isArray(raw.projectInitScripts) && raw.projectInitScripts.length > 0;
}

export async function planInit(target: string, host: string, requested: readonly string[]): Promise<InitPlan> {
  if (host !== "pi" && host !== "claude-code") throw new Error(`Unsupported host '${host}'; choose pi or claude-code`);
  const packs = closure(requested);
  const existing = existingInstallation(target, host, packs);
  if (existing?.kind === "same") return existing.plan;
  if (existing === undefined) assertEmpty(target);
  const stage = mkdtempSync(join(tmpdir(), "bounded-init-plan-"));
  try {
    await assemble(stage, host, packs, projectNameOf(target));
    return planFromStage(stage, host, packs, existing?.previous.digest);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export async function applyInit(target: string, host: string, requested: readonly string[], reviewedDigest: string): Promise<InitPlan> {
  if (host !== "pi" && host !== "claude-code") throw new Error(`Unsupported host '${host}'`);
  if (!/^[a-f0-9]{64}$/.test(reviewedDigest)) throw new Error("Supply the SHA-256 digest of a reviewed plan");
  const packs = closure(requested);
  const existing = existingInstallation(target, host, packs);
  if (existing?.kind === "same") {
    if (existing.plan.digest !== reviewedDigest) throw new Error("Existing installation differs from the reviewed plan; bounded update is required");
    return existing.plan;
  }
  if (existing === undefined) assertEmpty(target);
  const stage = mkdtempSync(join(tmpdir(), "bounded-init-apply-"));
  let replaced: { restore(): void; discard(): void } | undefined;
  try {
    await assemble(stage, host, packs, projectNameOf(target));
    const plan = planFromStage(stage, host, packs, existing?.previous.digest);
    if (plan.digest !== reviewedDigest) throw new Error("Plan changed since review; run bounded init with the same options again");
    writeFileSync(join(stage, MANIFEST), JSON.stringify(plan, null, 2) + "\n");
    if (existing !== undefined) replaced = removeInstallation(target, existing);
    const created: string[] = [];
    const directories: string[] = [];
    try {
      assertEmpty(target);
      mkdirSync(target, { recursive: true });
      for (const path of walk(stage).sort().filter((path) => !path.startsWith(".bounded/guard-") && !path.startsWith(".bounded/run-"))) {
        const dest = join(target, path);
        if (existsSync(dest)) throw new Error(`Destination collision: ${path}`);
        let current = target;
        for (const part of path.split("/").slice(0, -1)) {
          current = join(current, part);
          if (!existsSync(current)) { mkdirSync(current); directories.push(current); }
        }
        copyFileSync(join(stage, path), dest);
        created.push(dest);
      }
    } catch (error) {
      for (const path of created.reverse()) rmSync(path, { force: true });
      for (const path of directories.reverse()) {
        if (existsSync(path) && readdirSync(path).length === 0) rmSync(path, { recursive: false });
      }
      replaced?.restore();
      throw error;
    }
    return plan;
  } finally {
    replaced?.discard();
    rmSync(stage, { recursive: true, force: true });
  }
}
