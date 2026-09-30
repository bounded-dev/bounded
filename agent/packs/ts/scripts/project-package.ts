// Generates a project's package manifests, its tsconfig.json and its
// bun.lock (ADR 2026-051, ADR 2026-054, ADR 2026-061, ADR 2026-062).
//
// The project initializer runs this through the ts pack's
// `projectManifestScripts` contribution, as
// `node project-package.ts <project> <harness source root> [<project name>]`,
// after the core has written its own files. The package format belongs to
// this pack, never the core: the core only runs the script. The same
// functions are what `sync-config` rewrites and what the phase gates' drift
// check compares against (project-config.ts).
//
// Everything here is a pure function of the composition and the design:
//
//   · the ROOT manifest: exactly one `projectPackageTemplate`, every pack's
//     `projectScripts`, `pins` and `projectCheckScripts`, and `workspaces`:
//     one `<root>/*` per composed workspace template (the context template's
//     root first, then the rest sorted);
//   · one manifest per WORKSPACE. Contexts come from the design contracts
//     (every `<context root>/<name>` whose source root holds a contract);
//     apps from the `workspaces:` maps in the TNs' front matter (TN-26-012
//     §9). A workspace manifest is its template's, named
//     `<scope>/<name>` and marked private. A context also gets `exports`
//     (`./domain`, `./application`, then `./adapters/<tech>` for each
//     composed adapter technology its design uses: `@exposedVia` and
//     `@implementedBy` tags and store ports in its application contracts;
//     in ids sorted, then out), and those technologies' pins and
//     `workspaceScripts`. Nothing on disk but the contracts decides it. Any other workspace depends on every context as
//     `workspace:*`: the design, not the builder's imports, decides the
//     edges, so a composition root the builder writes can never change the
//     config under a running gate.
//   · `tsconfig.json`: the example's, extending the shipped
//     `tsconfig.base.json`, including every source root and each root-level
//     generated TypeScript file (`architecture.test.ts`).
//   · the composed packs' root config files, with `{{project}}` filled.
//   · `bun.lock`: produced by `bun install --lockfile-only` in a scratch copy
//     of the manifests (so a failure writes nothing), and verified without
//     the network (`bunLockProblems`): its workspaces are exactly the
//     generated manifests, and every pin resolves to exactly its version.
//
// The project's NAME is the one input read back from disk: the root
// manifest's `name`, set at init from the project directory's name. The
// package scope is `@<name>`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../../../src/is-main-module.ts";
import {
  contributionsByPack,
  generatedFileGlobsFor,
  mergedContribution,
  projectConfigSources,
  sourceRootsFor,
} from "../../../src/pack-contrib.ts";
import { readProjectPacks } from "../../../src/project-composition.ts";
import { composePacks } from "../../../src/socket-registry.ts";
import { INSTALLED_PACKS } from "../../installed.ts";
import {
  adapterTechnologies,
  skeletonEmitters,
  workspaceTemplates,
  type AdapterTechnology,
  type ProjectFacts,
  type WorkspaceFacts,
  type WorkspaceTemplate,
} from "../pack.ts";

/** A JSON object as written to a manifest. */
export type Manifest = Record<string, unknown>;

/** The root manifest's fields, in the order they are written. */
export type RootManifest = {
  name: string;
  private: true;
  type: string;
  workspaces?: string[];
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export const MANIFEST = "package.json";
export const LOCKFILE = "bun.lock";
export const TSCONFIG = "tsconfig.json";
/** Where the fingerprint of bun.lock's clean resolution is recorded: harness
 *  state no role may write (every role is refused `.bounded/`). */
export const LOCK_FINGERPRINT = ".bounded/lockfile-fingerprint.json";
/** The workspace template kind whose workspaces come from contract paths. */
export const CONTEXT_KIND = "context";
/** The name a project gets when the initializer is given none. */
export const DEFAULT_PROJECT_NAME = "bounded-project";

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const WORKSPACE_VERSION = "workspace:*";
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies"] as const;
const IGNORED_DIRS = new Set(["node_modules"]);

type Section = (typeof DEPENDENCY_SECTIONS)[number];

export function mergeProjectFields(target: Record<string, string>, added: Record<string, string>, kind: string, pack: string): void {
  for (const [name, value] of Object.entries(added)) {
    const previous = Object.hasOwn(target, name) ? target[name] : undefined;
    if (previous !== undefined && previous !== value) {
      throw new Error(`${kind} '${name}' conflicts with capability '${pack}'`);
    }
    Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
  }
}

const sorted = (record: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The manifest's bytes: two-space JSON and a final newline. */
export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

// --- the root manifest -----------------------------------------------------------

/** `workspaces` globs: the context template's root first, then the others sorted. */
export function workspaceGlobs(templates: readonly WorkspaceTemplate[]): string[] {
  const context = templates.filter((t) => t.kind === CONTEXT_KIND).map((t) => t.root);
  const others = templates.filter((t) => t.kind !== CONTEXT_KIND).map((t) => t.root).sort();
  return [...new Set([...context, ...others])].map((root) => `${root}/*`);
}

/**
 * The root package manifest the composed packs describe. `name` is the
 * project's name; `workspaces` defaults to the composed templates' roots.
 */
export function packageFor(
  packs: readonly string[],
  packsDir: string,
  options: { readonly name?: string; readonly workspaces?: readonly string[] } = {},
): RootManifest {
  const templates = contributionsByPack("projectPackageTemplate", packs, packsDir);
  for (const { pack, value } of templates) {
    if (typeof value !== "string" || !/^[a-z0-9/._-]+\.json$/.test(value) || value.includes("..")) {
      throw new Error(`Capability '${pack}' has an invalid projectPackageTemplate`);
    }
  }
  if (templates.length !== 1) throw new Error("Selected capabilities must provide exactly one project package template");
  const template = templates[0]!;
  const pkg = JSON.parse(readFileSync(join(packsDir, template.pack, template.value as string), "utf8")) as Manifest;
  if (!pkg || typeof pkg !== "object" || !isStringRecord(pkg["scripts"]) ||
      !isStringRecord(pkg["dependencies"]) || !isStringRecord(pkg["devDependencies"])) {
    throw new Error(`Capability '${template.pack}' has an invalid project package template`);
  }
  const scripts: Record<string, string> = { ...(pkg["scripts"] as Record<string, string>) };
  const deps: Record<Section, Record<string, string>> = {
    dependencies: { ...(pkg["dependencies"] as Record<string, string>) },
    devDependencies: { ...(pkg["devDependencies"] as Record<string, string>) },
  };
  for (const { pack, value } of contributionsByPack("projectScripts", packs, packsDir)) {
    if (!isStringRecord(value) || Object.values(value).some((command) => !command.trim())) {
      throw new Error(`Capability '${pack}' has invalid projectScripts`);
    }
    mergeProjectFields(scripts, value, "Project script", pack);
  }
  for (const { pack, value } of contributionsByPack("pins", packs, packsDir)) {
    for (const kind of DEPENDENCY_SECTIONS) {
      const pins = (value as Partial<Record<Section, unknown>> | null)?.[kind];
      if (pins === undefined) continue;
      if (!isStringRecord(pins) || Object.values(pins).some((version) => !version)) {
        throw new Error(`Capability '${pack}' has invalid ${kind} pins`);
      }
      mergeProjectFields(deps[kind], pins, "Dependency", pack);
    }
  }
  // A pack may fold one of the scripts into the project's own `check`, in
  // composition order, the way deliver folds its checks (ADR 2026-054): the
  // generated manifest is then already the delivered one.
  for (const { pack, value } of contributionsByPack("projectCheckScripts", packs, packsDir)) {
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !Object.hasOwn(scripts, name))) {
      throw new Error(`Capability '${pack}' has invalid projectCheckScripts: each must name a project script`);
    }
    for (const name of value as string[]) {
      const check = scripts["check"];
      if (check === undefined) scripts["check"] = `bun run ${name}`;
      else if (!check.includes(`run ${name}`)) scripts["check"] = `${check} && bun run ${name}`;
    }
  }
  for (const name of Object.keys(deps.dependencies)) {
    if (name in deps.devDependencies) throw new Error(`Dependency '${name}' is both production and development`);
  }
  const workspaces = options.workspaces ?? workspaceGlobs(workspaceTemplates(packs, packsDir));
  return {
    name: options.name ?? DEFAULT_PROJECT_NAME,
    private: true,
    type: typeof pkg["type"] === "string" ? pkg["type"] : "module",
    ...(workspaces.length > 0 ? { workspaces: [...workspaces] } : {}),
    scripts,
    ...(Object.keys(deps.dependencies).length > 0 ? { dependencies: sorted(deps.dependencies) } : {}),
    ...(Object.keys(deps.devDependencies).length > 0 ? { devDependencies: sorted(deps.devDependencies) } : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string");
}

// --- the project's name ----------------------------------------------------------

/** A project name as a package name: lowercase letters, digits and dashes. */
export function checkedProjectName(name: string): string {
  if (!PROJECT_NAME.test(name)) {
    throw new Error(`project name '${name}' must be lowercase letters, digits and dashes, starting with a letter or digit`);
  }
  return name;
}

/** The project directory's name made into a project name, or the default. */
export function projectNameFromDirectory(dir: string): string {
  const candidate = dir.split(/[\\/]/).filter((s) => s !== "").at(-1)?.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") ?? "";
  return PROJECT_NAME.test(candidate) ? candidate : DEFAULT_PROJECT_NAME;
}

/** The project's recorded name: its root manifest's `name`, or, when there
 *  is no root manifest at all, the project directory's name (as init chose
 *  it). Throws when the manifest is unreadable or its name is not a valid
 *  project name: a hand-edited name is never silently replaced. */
export function readProjectName(project: string): string {
  const path = join(project, MANIFEST);
  if (!existsSync(path)) return projectNameFromDirectory(resolve(project));
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${MANIFEST} is unreadable, and it records the project's name (and so the package scope)`);
  }
  const name = (manifest as { name?: unknown } | null)?.name;
  if (typeof name !== "string") throw new Error(`${MANIFEST} has no name, and it records the project's name (and so the package scope)`);
  return checkedProjectName(name);
}

export const scopeOf = (name: string): string => `@${name}`;

// --- workspaces ------------------------------------------------------------------

/** One workspace of the project (ADR 2026-061). */
export interface ProjectWorkspace {
  /** e.g. `contexts/project-management`, `apps/web`. */
  readonly dir: string;
  /** Last segment of `dir`. */
  readonly name: string;
  /** The `workspaceTemplates` kind. */
  readonly kind: string;
  /** `<scope>/<name>`. */
  readonly packageName: string;
  /** The concrete source root inside it, e.g. `contexts/project-management/src`. */
  readonly sourceRoot: string;
}

const TN_WORKSPACE_LINE = /^ {2}([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*): ([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

/**
 * The `workspaces:` map of one TN's front matter (TN-26-012 §9), or
 * undefined when it has none. The core validates the shape too; this reader
 * refuses anything outside it rather than guessing.
 */
export function tnWorkspaces(text: string, where: string): Map<string, string> | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end === -1) return undefined;
  const front = lines.slice(1, end);
  const start = front.indexOf("workspaces:");
  if (start === -1) {
    if (front.some((line) => /^workspaces\s*:/.test(line))) throw new Error(`${where}: 'workspaces:' must be a block of 'dir: kind' lines`);
    return undefined;
  }
  const map = new Map<string, string>();
  for (const line of front.slice(start + 1)) {
    if (!/^\s/.test(line) || line.trim() === "") {
      if (line.trim() === "" && line !== "") throw new Error(`${where}: a blank indented line inside 'workspaces:'`);
      break;
    }
    const match = TN_WORKSPACE_LINE.exec(line);
    if (match === null) throw new Error(`${where}: '${line.trim()}' is not a 'dir: kind' workspaces entry`);
    if (map.has(match[1]!)) throw new Error(`${where}: workspace '${match[1]}' is declared twice`);
    map.set(match[1]!, match[2]!);
  }
  return map;
}

/** Every TN's `workspaces:` map under `docs/tn/`, merged; one directory
 *  declared with two kinds is refused. */
export function declaredWorkspaces(project: string): Map<string, string> {
  const dir = join(project, "docs", "tn");
  const merged = new Map<string, string>();
  if (!existsSync(dir)) return merged;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const declared = tnWorkspaces(readFileSync(join(dir, file), "utf8"), `docs/tn/${file}`);
    for (const [path, kind] of declared ?? []) {
      const previous = merged.get(path);
      if (previous !== undefined && previous !== kind) {
        throw new Error(`workspace '${path}' is declared as '${previous}' and as '${kind}' (docs/tn/${file})`);
      }
      merged.set(path, kind);
    }
  }
  return merged;
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The concrete directories a source-root glob names in the project. */
function expandRoot(project: string, glob: string): string[] {
  let current = [""];
  for (const segment of glob.split("/")) {
    const next: string[] = [];
    for (const base of current) {
      if (segment === "*") {
        const dir = join(project, base);
        if (!isDirectory(dir)) continue;
        for (const entry of readdirSync(dir).sort()) {
          if (entry.startsWith(".") || IGNORED_DIRS.has(entry)) continue;
          if (isDirectory(join(dir, entry))) next.push(base === "" ? entry : `${base}/${entry}`);
        }
      } else {
        const path = base === "" ? segment : `${base}/${segment}`;
        if (isDirectory(join(project, path))) next.push(path);
      }
    }
    current = next;
  }
  return current;
}

/** Does `dir` (project-relative) hold a file with one of `suffixes`, at any depth? */
function holdsContract(project: string, dir: string, suffixes: readonly string[]): boolean {
  for (const entry of readdirSync(join(project, dir), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (holdsContract(project, `${dir}/${entry.name}`, suffixes)) return true;
    } else if (suffixes.some((suffix) => entry.name.toLowerCase().endsWith(suffix))) return true;
  }
  return false;
}

/** The source root of a declared workspace: the one root glob whose parent
 *  matches the directory and whose last segment is literal. */
function sourceRootFor(dir: string, roots: readonly string[]): string | undefined {
  const segments = dir.split("/");
  for (const root of roots) {
    const rootSegments = root.split("/");
    const parent = rootSegments.slice(0, -1);
    const last = rootSegments.at(-1)!;
    if (parent.length !== segments.length || last === "*") continue;
    if (parent.every((s, i) => s === "*" || s === segments[i])) return `${dir}/${last}`;
  }
  return undefined;
}

/** What the workspace generator reads from the composition. */
export interface Layout {
  readonly packs: readonly string[];
  readonly packsDir: string;
  readonly sourceRoots: readonly string[];
  readonly contractSuffixes: readonly string[];
  readonly templates: readonly WorkspaceTemplate[];
  readonly technologies: readonly AdapterTechnology[];
  readonly generatedGlobs: readonly string[];
}

export function layoutFor(packs: readonly string[], packsDir: string): Layout {
  return {
    packs,
    packsDir,
    sourceRoots: sourceRootsFor(packs, packsDir),
    contractSuffixes: mergedContribution("contractFileSuffixes", packs, packsDir).map((s) => s.toLowerCase()),
    templates: workspaceTemplates(packs, packsDir),
    technologies: adapterTechnologies(packs, packsDir),
    generatedGlobs: generatedFileGlobsFor(packs, packsDir),
  };
}

/**
 * The project's workspaces, sorted by directory: contexts from contract paths
 * and apps from the TNs (ADR 2026-061). Throws, naming the file and the fix,
 * for a contract outside every workspace a template can hold, a declared kind
 * the composition lacks, a declaration outside its template's root, or two
 * workspaces with one package name.
 */
export function projectWorkspaces(project: string, layout: Layout, scope: string): ProjectWorkspace[] {
  if (layout.templates.length === 0) return [];
  const byKind = new Map(layout.templates.map((t) => [t.kind, t]));
  const context = byKind.get(CONTEXT_KIND);
  const declared = declaredWorkspaces(project);
  const found = new Map<string, { kind: string; sourceRoot: string }>();

  for (const [dir, kind] of declared) {
    const template = byKind.get(kind);
    if (kind === CONTEXT_KIND) throw new Error(`workspace '${dir}' is declared as a context; contexts come from contract paths, not TNs`);
    if (template === undefined) throw new Error(`workspace '${dir}' is declared as '${kind}', which no composed pack's workspace template provides`);
    const segments = dir.split("/");
    if (segments.length !== 2 || segments[0] !== template.root) {
      throw new Error(`workspace '${dir}' must be '${template.root}/<name>' for a '${kind}' workspace`);
    }
    const sourceRoot = sourceRootFor(dir, layout.sourceRoots);
    if (sourceRoot === undefined) throw new Error(`workspace '${dir}' has no source root in the composed sourceRoots`);
    found.set(dir, { kind, sourceRoot });
  }

  for (const glob of layout.sourceRoots) {
    for (const root of expandRoot(project, glob)) {
      if (!holdsContract(project, root, layout.contractSuffixes)) continue;
      const dir = root.split("/").slice(0, -1).join("/");
      if (found.has(dir)) continue;
      const segments = dir.split("/");
      if (context === undefined || segments.length !== 2 || segments[0] !== context.root) {
        throw new Error(`${root} holds design contracts, but '${dir}' is neither a context ` +
          `(${context === undefined ? "no composed pack provides the context template" : `${context.root}/<name>`}) ` +
          "nor a workspace a TN declares");
      }
      found.set(dir, { kind: CONTEXT_KIND, sourceRoot: root });
    }
  }

  const byPackage = new Map<string, string>();
  const out: ProjectWorkspace[] = [];
  for (const [dir, { kind, sourceRoot }] of [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const name = dir.split("/").at(-1)!;
    const packageName = `${scope}/${name}`;
    const clash = byPackage.get(packageName);
    if (clash !== undefined) throw new Error(`workspaces '${clash}' and '${dir}' would both be the package '${packageName}'`);
    byPackage.set(packageName, dir);
    out.push({ dir, name, kind, packageName, sourceRoot });
  }
  return out;
}

// --- workspace manifests ---------------------------------------------------------

const PLACEHOLDER = /\{\{([^}]*)\}\}/g;

function substitute(value: unknown, vars: Readonly<Record<string, string>>, where: string): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (_whole, key: string) => {
      const replacement = vars[key];
      if (replacement === undefined) throw new Error(`${where} uses '{{${key}}}'; only {{scope}}, {{name}}, {{package}} and {{entries}} exist`);
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars, where));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars, where)]));
  }
  return value;
}

function checkedPins(record: unknown, where: string): Record<string, string> {
  if (record === undefined) return {};
  if (!isStringRecord(record)) throw new Error(`${where} must be an object of package names to versions`);
  for (const [name, version] of Object.entries(record)) {
    if (!EXACT_VERSION.test(version)) throw new Error(`${where} pins '${name}' to '${version}', which is not an exact version`);
  }
  return record;
}

function addPins(target: Record<string, string>, added: Readonly<Record<string, string>>, where: string): void {
  for (const [name, version] of Object.entries(added)) {
    const previous = target[name];
    if (previous !== undefined && previous !== version) throw new Error(`${where}: '${name}' is pinned to both ${previous} and ${version}`);
    target[name] = version;
  }
}

const TAG_LINE = /^\s*\*\s*@(exposedVia|implementedBy)((?:\s+[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+)\s*$/;
const STORE_PORT = /^\s*export\s+interface\s+[A-Z][A-Za-z0-9]*Store\b/m;

/** Every design contract file under `dir` (project-relative), sorted. */
function contractFiles(project: string, dir: string, suffixes: readonly string[]): string[] {
  if (!isDirectory(join(project, dir))) return [];
  const out: string[] = [];
  for (const entry of readdirSync(join(project, dir), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...contractFiles(project, path, suffixes));
    else if (suffixes.some((s) => entry.name.toLowerCase().endsWith(s))) out.push(path);
  }
  return out.sort();
}

/**
 * The adapter technologies a context's DESIGN uses (ADR 2026-061,
 * TN-26-012 §4), read from its application contracts, never from folders
 * on disk, so no role can change a manifest by creating a directory:
 *
 *   · an in technology when a feature names it in `@exposedVia`;
 *   · an out technology when an out port names it in `@implementedBy`;
 *   · every composed storage technology when any feature has a
 *     `<InPort>Store` port (a store is implemented once per storage
 *     technology).
 *
 * A tag naming a technology no composed pack provides is refused.
 */
export function designedTechnologies(project: string, workspace: ProjectWorkspace, layout: Layout): Set<string> {
  const used = new Set<string>();
  const byId = new Map(layout.technologies.map((t) => [t.id, t]));
  let stores = false;
  for (const path of contractFiles(project, `${workspace.sourceRoot}/application`, layout.contractSuffixes)) {
    const source = readFileSync(join(project, path), "utf8");
    if (STORE_PORT.test(source)) stores = true;
    for (const line of source.split(/\r?\n/)) {
      const tag = TAG_LINE.exec(line);
      if (tag === null) continue;
      const direction = tag[1] === "exposedVia" ? "in" : "out";
      for (const id of tag[2]!.trim().split(/\s+/)) {
        const tech = byId.get(id);
        if (tech === undefined || tech.direction !== direction) {
          throw new Error(`${path}: @${tag[1]} names '${id}', which no composed pack provides as an ${direction} adapter technology`);
        }
        used.add(id);
      }
    }
  }
  if (stores) for (const tech of layout.technologies) if (tech.storage) used.add(tech.id);
  return used;
}

/** Posix join of project-relative path parts. */
const rel = (...parts: string[]): string => parts.filter((p) => p !== "").join("/");

/**
 * One workspace's manifest: the template (placeholders filled, no `name`),
 * named and marked private; for a context, `exports` and the pins of each
 * adapter technology present; for any other kind, a `workspace:*`
 * dependency on every context.
 */
export function workspaceManifest(
  project: string,
  workspace: ProjectWorkspace,
  layout: Layout,
  contexts: readonly ProjectWorkspace[],
  scope: string,
  entries: readonly string[] = [],
): Manifest {
  const template = layout.templates.find((t) => t.kind === workspace.kind);
  if (template === undefined) throw new Error(`no composed workspace template for kind '${workspace.kind}'`);
  const where = `Pack '${template.pack}' workspace template '${template.kind}' manifest`;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(layout.packsDir, template.pack, template.manifest), "utf8"));
  } catch {
    throw new Error(`${where} is not valid JSON`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be a JSON object`);
  for (const forbidden of ["name", "exports", "workspaces", "optionalDependencies", "peerDependencies"]) {
    if (Object.hasOwn(raw, forbidden)) throw new Error(`${where} may not declare '${forbidden}'; the generator owns it`);
  }
  const filled = substitute(raw, { scope, name: workspace.name, package: workspace.packageName, entries: entries.join(" ") }, where) as Manifest;
  const deps: Record<Section, Record<string, string>> = {
    dependencies: { ...checkedPins(filled["dependencies"], `${where} dependencies`) },
    devDependencies: { ...checkedPins(filled["devDependencies"], `${where} devDependencies`) },
  };
  let exportsField: Record<string, string> | undefined;
  let scripts: Record<string, string> | undefined;
  const inside = workspace.sourceRoot.slice(workspace.dir.length + 1);
  if (workspace.kind === CONTEXT_KIND) {
    exportsField = {
      "./domain": `./${rel(inside, "domain", "index.ts")}`,
      "./application": `./${rel(inside, "application", "index.ts")}`,
    };
    const used = designedTechnologies(project, workspace, layout);
    const present = layout.technologies.filter((t) => used.has(t.id));
    const templateScripts = filled["scripts"];
    if (templateScripts !== undefined && !isStringRecord(templateScripts)) throw new Error(`${where} scripts must map names to commands`);
    scripts = { ...(templateScripts ?? {}) };
    for (const direction of ["in", "out"] as const) {
      for (const tech of present.filter((t) => t.direction === direction)) {
        const named = `${workspace.dir} (adapter technology '${tech.id}')`;
        exportsField[`./adapters/${tech.id}`] = `./${rel(inside, "adapters", direction, tech.id, "index.ts")}`;
        for (const section of DEPENDENCY_SECTIONS) addPins(deps[section], tech.pins[section], named);
        for (const [name, command] of Object.entries(tech.workspaceScripts ?? {})) {
          if (Object.hasOwn(scripts, name)) throw new Error(`${named}: script '${name}' is also the workspace template's`);
          scripts[name] = command;
        }
      }
    }
  } else {
    for (const context of contexts) addPins(deps.dependencies, { [context.packageName]: WORKSPACE_VERSION }, workspace.dir);
  }
  for (const name of Object.keys(deps.dependencies)) {
    if (name in deps.devDependencies) throw new Error(`${workspace.dir}: '${name}' is both a dependency and a devDependency`);
  }
  const rest = Object.fromEntries(Object.entries(filled)
    .filter(([key]) => key !== "private" && !(DEPENDENCY_SECTIONS as readonly string[]).includes(key))
    .map(([key, value]) => [key, key === "scripts" && scripts !== undefined ? scripts : value]));
  return {
    name: workspace.packageName,
    private: true,
    ...rest,
    ...(scripts !== undefined && !Object.hasOwn(rest, "scripts") && Object.keys(scripts).length > 0 ? { scripts } : {}),
    ...(exportsField !== undefined ? { exports: exportsField } : {}),
    ...(Object.keys(deps.dependencies).length > 0 ? { dependencies: sorted(deps.dependencies) } : {}),
    ...(Object.keys(deps.devDependencies).length > 0 ? { devDependencies: sorted(deps.devDependencies) } : {}),
  };
}

/** Does any composed workspace template's manifest use `{{entries}}`? */
function templatesUseEntries(layout: Layout): boolean {
  return layout.templates.some((t) => readFileSync(join(layout.packsDir, t.pack, t.manifest), "utf8").includes("{{entries}}"));
}

/**
 * `{{entries}}` per workspace (TN-26-012 §10): the workspace-relative paths
 * of the files the composed emitters produce for it with `entry: true`,
 * sorted by code point. The emitters see the design exactly as the design
 * gate hands it to them, so the manifest and the seeded entries agree.
 */
export function emittedEntries(
  project: string,
  layout: Layout,
  workspaces: readonly ProjectWorkspace[],
  scope: string,
): Map<string, string[]> {
  const facts: ProjectFacts = {
    scope,
    phase: "design",
    packs: layout.packs,
    workspaces: workspaces.map((w): WorkspaceFacts => ({
      ...w,
      contracts: contractFiles(project, w.sourceRoot, layout.contractSuffixes)
        .map((path) => ({ path, source: readFileSync(join(project, path), "utf8") })),
    })),
    adapterTechnologies: layout.technologies,
    workspaceTemplates: layout.templates,
  };
  const out = new Map<string, string[]>();
  for (const emitter of composePacks(INSTALLED_PACKS, layout.packs).read(skeletonEmitters)) {
    for (const file of emitter.emit(facts)) {
      if (file.entry !== true) continue;
      const workspace = workspaces.find((w) => file.path.startsWith(`${w.dir}/`));
      if (workspace === undefined) throw new Error(`emitter '${emitter.name}' marked ${file.path} as an entry outside every workspace`);
      out.set(workspace.dir, [...(out.get(workspace.dir) ?? []), file.path.slice(workspace.dir.length + 1)]);
    }
  }
  for (const list of out.values()) list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/** Every manifest the composition and design generate, keyed by workspace
 *  directory (`""` for the root). One version per package across them all. */
export interface GeneratedManifests {
  readonly name: string;
  readonly scope: string;
  readonly workspaces: readonly ProjectWorkspace[];
  readonly manifests: ReadonlyMap<string, Manifest>;
}

export function generatedManifests(project: string, packs: readonly string[], packsDir: string, name: string): GeneratedManifests {
  const layout = layoutFor(packs, packsDir);
  const scope = scopeOf(checkedProjectName(name));
  const workspaces = projectWorkspaces(project, layout, scope);
  const contexts = workspaces.filter((w) => w.kind === CONTEXT_KIND);
  const manifests = new Map<string, Manifest>([["", packageFor(packs, packsDir, { name, workspaces: workspaceGlobs(layout.templates) })]]);
  const entries = templatesUseEntries(layout) ? emittedEntries(project, layout, workspaces, scope) : new Map<string, string[]>();
  for (const workspace of workspaces) {
    manifests.set(workspace.dir, workspaceManifest(project, workspace, layout, contexts, scope, entries.get(workspace.dir) ?? []));
  }
  const versions = new Map<string, { version: string; where: string }>();
  for (const [dir, manifest] of manifests) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [dep, version] of Object.entries((manifest[section] ?? {}) as Record<string, string>)) {
        const previous = versions.get(dep);
        if (previous !== undefined && previous.version !== version) {
          throw new Error(`'${dep}' is pinned to ${previous.version} in ${previous.where} and to ${version} in ${dir || "the root"}`);
        }
        versions.set(dep, { version, where: dir || "the root" });
      }
    }
  }
  return { name, scope, workspaces, manifests };
}

/** Project path of a workspace directory's manifest. */
export const manifestPath = (dir: string): string => (dir === "" ? MANIFEST : `${dir}/${MANIFEST}`);

// --- tsconfig.json ---------------------------------------------------------------

/**
 * The generated `tsconfig.json`: the example's, extending the shipped
 * `tsconfig.base.json`. It includes every composed source root, then every
 * root-level TypeScript file a composed generator owns (such as
 * `architecture.test.ts`).
 */
export function tsconfigFor(packs: readonly string[], packsDir: string): string {
  const rootFiles = generatedFileGlobsFor(packs, packsDir).filter((g) => !g.includes("/") && !g.includes("*") && /\.tsx?$/.test(g));
  const config = {
    extends: "./tsconfig.base.json",
    compilerOptions: { lib: ["ESNext", "DOM"] },
    include: [...sourceRootsFor(packs, packsDir), ...rootFiles.sort()],
  };
  return JSON.stringify(config, null, 2) + "\n";
}

// --- root config files -------------------------------------------------------------

/**
 * A composed pack's root config file (`projectConfigFiles`) as the project
 * gets it: `{{project}}` becomes the project's name, the scope without its
 * `@` (TN-26-012 §10; ts-drizzle-postgres names the database with it). Any
 * other `{{…}}` placeholder is refused.
 */
export function renderConfigFile(text: string, name: string, where: string): string {
  return text.replace(PLACEHOLDER, (_whole, key: string) => {
    if (key !== "project") throw new Error(`${where} uses '{{${key}}}'; a root config file may use only {{project}}`);
    return name;
  });
}

/** Every composed root config file, rendered: project path → bytes. */
export function configFiles(packs: readonly string[], packsDir: string, name: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const { pack, source, target } of projectConfigSources(packs, packsDir)) {
    if (target === MANIFEST || target === LOCKFILE || target === TSCONFIG) {
      throw new Error(`Capability '${pack}' may not ship ${target} as a config file: it is generated`);
    }
    out.set(target, renderConfigFile(readFileSync(source, "utf8"), name, `Capability '${pack}' config file ${target}`));
  }
  return out;
}

// --- shipped files ---------------------------------------------------------------

/** One file a composed pack ships verbatim to a fixed project path. */
export interface ShippedFile {
  readonly path: string;
  readonly source: string;
}

/**
 * The composed packs' `projectShippedFiles` (ADR 2026-054): project-relative
 * path → pack-relative source, copied byte for byte. The ts pack ships the
 * surface checker its generated `check:surface` script runs.
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

// --- bun.lock --------------------------------------------------------------------

/** Parse bun's text lockfile: JSON with trailing commas. */
export function parseBunLock(text: string): Record<string, unknown> {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  const parsed: unknown = JSON.parse(out);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bun.lock is not an object");
  return parsed as Record<string, unknown>;
}

const LOCK_KEYS = new Set(["lockfileVersion", "configVersion", "workspaces", "packages"]);
const LOCK_WORKSPACE_KEYS = new Set(["name", ...DEPENDENCY_SECTIONS]);

function sameRecord(a: unknown, b: unknown): boolean {
  const left = Object.entries((a ?? {}) as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1));
  const right = Object.entries((b ?? {}) as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1));
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Why `lockText` is not the lockfile of exactly these manifests, without the
 * network: every problem, or none. The lockfile must declare exactly the
 * generated workspaces with exactly their names and dependency maps (what
 * `bun install --frozen-lockfile` compares), resolve every workspace package
 * to its own directory, resolve every pinned package to exactly its pinned
 * version, and carry nothing the manifests do not declare (overrides,
 * patches, trusted dependencies, catalogs).
 */
export function bunLockProblems(
  lockText: string,
  manifests: ReadonlyMap<string, Manifest>,
  fingerprint?: LockFingerprint,
): string[] {
  let lock: Record<string, unknown>;
  try {
    lock = parseBunLock(lockText);
  } catch (error) {
    return [`it cannot be parsed (${error instanceof Error ? error.message : String(error)})`];
  }
  const problems: string[] = [];
  if (lock["lockfileVersion"] !== 1) problems.push(`lockfileVersion is ${JSON.stringify(lock["lockfileVersion"])}, not 1`);
  for (const key of Object.keys(lock)) if (!LOCK_KEYS.has(key)) problems.push(`it declares '${key}', which no generated manifest does`);
  const workspaces = (lock["workspaces"] ?? {}) as Record<string, Record<string, unknown>>;
  const packages = (lock["packages"] ?? {}) as Record<string, unknown>;
  const expectedDirs = [...manifests.keys()].sort();
  const actualDirs = Object.keys(workspaces).sort();
  for (const dir of expectedDirs) if (!actualDirs.includes(dir)) problems.push(`workspace '${dir || "(root)"}' is missing`);
  for (const dir of actualDirs) if (!expectedDirs.includes(dir)) problems.push(`workspace '${dir || "(root)"}' is not generated`);
  const workspaceOf = new Map<string, string>();
  for (const [dir, manifest] of manifests) if (dir !== "") workspaceOf.set(manifest["name"] as string, dir);
  for (const [dir, manifest] of manifests) {
    const entry = workspaces[dir];
    if (entry === undefined) continue;
    const label = dir || "(root)";
    if (entry["name"] !== manifest["name"]) problems.push(`workspace '${label}' is named ${JSON.stringify(entry["name"])}, not ${JSON.stringify(manifest["name"])}`);
    for (const key of Object.keys(entry)) if (!LOCK_WORKSPACE_KEYS.has(key)) problems.push(`workspace '${label}' declares '${key}'`);
    for (const section of DEPENDENCY_SECTIONS) {
      if (!sameRecord(entry[section], manifest[section])) problems.push(`workspace '${label}' ${section} differ from its manifest`);
    }
  }
  const pinned = new Map<string, string>();
  for (const manifest of manifests.values()) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [dep, version] of Object.entries((manifest[section] ?? {}) as Record<string, string>)) pinned.set(dep, version);
    }
  }
  for (const [dep, version] of [...pinned].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entry = packages[dep];
    const resolved = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : undefined;
    const expected = version === WORKSPACE_VERSION ? `${dep}@workspace:${workspaceOf.get(dep) ?? "?"}` : `${dep}@${version}`;
    if (resolved === undefined) problems.push(`'${dep}' is not resolved`);
    else if (resolved !== expected) problems.push(`'${dep}' resolves to ${resolved}, not ${expected}`);
  }
  for (const [key, entry] of Object.entries(packages)) {
    const resolved = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : "";
    const workspace = /^(.+)@workspace:(.+)$/.exec(resolved);
    if (workspace !== null && workspaceOf.get(workspace[1]!) !== workspace[2]) {
      problems.push(`package '${key}' is a workspace no generated manifest declares`);
    }
  }
  problems.push(...closureProblems(packages, manifests));
  if (fingerprint !== undefined) problems.push(...fingerprintProblems(packages, fingerprint));
  return problems;
}

const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

/** A lockfile key as its chain of package names: `tsx/esbuild` →
 *  [tsx, esbuild], `@a/b/@c/d` → [@a/b, @c/d]. */
function chainOf(key: string): string[] {
  const parts = key.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts[i]!.startsWith("@") && i + 1 < parts.length ? `${parts[i]}/${parts[++i]}` : parts[i]!);
  return out;
}

/** The key a dependency of `parent` resolves to: bun's nearest-first lookup
 *  (`parent/dep`, then each ancestor's `…/dep`, then top-level `dep`). */
function resolveKey(packages: Record<string, unknown>, parent: string, dep: string): string | undefined {
  const chain = chainOf(parent);
  for (let n = chain.length; n >= 0; n--) {
    const key = [...chain.slice(0, n), dep].join("/");
    if (Object.hasOwn(packages, key)) return key;
  }
  return undefined;
}

/**
 * The lockfile's own consistency, without the registry: every package
 * comes from the default registry (bun writes an empty URL for it), carries
 * a sha512 integrity, every dependency a package declares resolves to an
 * entry, and every entry is reachable from a generated manifest (nothing is
 * injected beside the tree). Optional dependencies may be absent; peers are
 * not followed.
 */
function closureProblems(packages: Record<string, unknown>, manifests: ReadonlyMap<string, Manifest>): string[] {
  const problems: string[] = [];
  const meta = (key: string): Record<string, unknown> => {
    const entry = packages[key];
    return Array.isArray(entry) && entry[2] !== null && typeof entry[2] === "object" ? entry[2] as Record<string, unknown> : {};
  };
  for (const [key, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      problems.push(`package '${key}' is not a bun lockfile entry`);
      continue;
    }
    if (/@workspace:/.test(entry[0])) continue;
    if (entry[1] !== "") problems.push(`package '${key}' comes from ${JSON.stringify(entry[1])}, not the default registry`);
    if (typeof entry[3] !== "string" || !INTEGRITY.test(entry[3])) problems.push(`package '${key}' has no sha512 integrity`);
  }
  const reached = new Set<string>();
  const queue: string[] = [];
  const visit = (parent: string, dep: string, optional: boolean, from: string): void => {
    const key = parent === "" ? (Object.hasOwn(packages, dep) ? dep : undefined) : resolveKey(packages, parent, dep);
    if (key === undefined) {
      if (!optional) problems.push(`'${dep}', a dependency of ${from}, resolves to no entry`);
      return;
    }
    if (!reached.has(key)) {
      reached.add(key);
      queue.push(key);
    }
  };
  for (const [dir, manifest] of manifests) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const dep of Object.keys((manifest[section] ?? {}) as Record<string, string>)) visit("", dep, false, dir || "the root");
    }
  }
  while (queue.length > 0) {
    const key = queue.shift()!;
    const m = meta(key);
    for (const [field, optional] of [["dependencies", false], ["optionalDependencies", true]] as const) {
      for (const dep of Object.keys((m[field] ?? {}) as Record<string, string>)) visit(key, dep, optional, `'${key}'`);
    }
  }
  for (const key of Object.keys(packages)) {
    const entry = packages[key];
    const isWorkspace = Array.isArray(entry) && typeof entry[0] === "string" && /@workspace:/.test(entry[0]);
    if (!reached.has(key) && !isWorkspace) problems.push(`package '${key}' is reachable from no generated manifest`);
  }
  return problems;
}

/** What a clean resolution produced: one hash per lockfile entry, over the
 *  whole entry (resolved version, registry URL, dependencies, integrity). */
export interface LockFingerprint {
  readonly version: 1;
  readonly packages: Readonly<Record<string, string>>;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v);

/** The fingerprint of a lockfile, recorded when bun produced it. */
export function lockFingerprint(lockText: string): LockFingerprint {
  const packages = (parseBunLock(lockText)["packages"] ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of Object.keys(packages).sort()) out[key] = createHash("sha256").update(canonical(packages[key])).digest("hex");
  return { version: 1, packages: out };
}

export function parseLockFingerprint(text: string): LockFingerprint {
  const value = JSON.parse(text) as Partial<LockFingerprint>;
  if (value.version !== 1 || value.packages === null || typeof value.packages !== "object" ||
      Object.values(value.packages).some((h) => typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h))) {
    throw new Error("the lockfile fingerprint is malformed");
  }
  return value as LockFingerprint;
}

export const serializeLockFingerprint = (fingerprint: LockFingerprint): string => JSON.stringify(fingerprint, null, 2) + "\n";

function fingerprintProblems(packages: Record<string, unknown>, fingerprint: LockFingerprint): string[] {
  const problems: string[] = [];
  const actual = new Map(Object.keys(packages).map((key) => [key, createHash("sha256").update(canonical(packages[key])).digest("hex")]));
  for (const [key, hash] of Object.entries(fingerprint.packages)) {
    const now = actual.get(key);
    if (now === undefined) problems.push(`package '${key}' of the clean resolution is missing`);
    else if (now !== hash) problems.push(`package '${key}' differs from the clean resolution (its version, registry URL, dependencies or integrity)`);
  }
  for (const key of actual.keys()) {
    if (!Object.hasOwn(fingerprint.packages, key)) problems.push(`package '${key}' is not in the clean resolution`);
  }
  return problems;
}

// --- the bun version ----------------------------------------------------------------

/** The bun release the ts pack is pinned to: its `@types/bun` pin, which
 *  bun versions in step with the runtime. */
export function pinnedBunVersion(): string {
  const template = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "reference", "package.json"), "utf8")) as
    { devDependencies: Record<string, string> };
  return template.devDependencies["@types/bun"]!;
}

let installedBun: string | null | undefined;

/** `bun --version`, once per process; null when bun is not on PATH. */
export function installedBunVersion(): string | null {
  if (installedBun === undefined) {
    try {
      installedBun = execFileSync("bun", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      installedBun = null;
    }
  }
  return installedBun;
}

/**
 * Why the bun on PATH cannot run this project's toolchain, or undefined. The
 * lockfile, the test run's report format and the console report the
 * sanitizer reads are all bun's, so a different major or minor release is
 * refused rather than trusted.
 */
export function bunVersionProblem(actual: string | null = installedBunVersion(), pinned: string = pinnedBunVersion()): string | undefined {
  const want = pinned.split(".").slice(0, 2).join(".");
  if (actual === null) return `bun is not on PATH: this project's toolchain is bun ${want}.x (ADR 2026-062); install it and retry`;
  const have = actual.split(".").slice(0, 2).join(".");
  if (have !== want) return `bun ${actual} is on PATH, but this project's toolchain is pinned to bun ${want}.x (ADR 2026-062); install bun ${pinned} and retry`;
  return undefined;
}

/** Produces `bun.lock` in a directory holding the manifests (and any
 *  previous lockfile). Throws when it cannot. */
export type LockfileMaker = (dir: string) => void;

/** `bun install --lockfile-only`: resolves from the registry (or bun's cache),
 *  installs nothing, runs nothing. */
export const bunLockfileMaker: LockfileMaker = (dir) => {
  const version = bunVersionProblem();
  if (version !== undefined) throw new Error(version);
  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts", "--no-progress", "--no-summary"], {
    cwd: dir,
    stdio: "pipe",
    timeout: 300_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
};

/** A lockfile with the fingerprint of the clean resolution that produced it. */
export interface FingerprintedLock {
  readonly lock: string;
  readonly fingerprint: LockFingerprint;
}

/**
 * The lockfile for these manifests. `previous` is kept when it verifies
 * against the manifests AND against its own recorded fingerprint. Otherwise
 * `maker` resolves in a scratch directory holding the manifests, seeded
 * with the previous lockfile only when that one still matches its
 * fingerprint (so unchanged resolutions are kept, and a tampered lockfile is
 * never trusted as a seed). The result is verified and fingerprinted.
 * Throws naming the first problem; never touches the project.
 */
export function lockfileFor(
  manifests: ReadonlyMap<string, Manifest>,
  previous: Partial<FingerprintedLock> | undefined,
  maker: LockfileMaker = bunLockfileMaker,
): FingerprintedLock {
  const prevLock = previous?.lock;
  const prevFingerprint = previous?.fingerprint;
  if (prevLock !== undefined && prevFingerprint !== undefined &&
      bunLockProblems(prevLock, manifests, prevFingerprint).length === 0) {
    return { lock: prevLock, fingerprint: prevFingerprint };
  }
  let trustedSeed: string | undefined;
  if (prevLock !== undefined && prevFingerprint !== undefined) {
    try {
      const packages = (parseBunLock(prevLock)["packages"] ?? {}) as Record<string, unknown>;
      if (fingerprintProblems(packages, prevFingerprint).length === 0) trustedSeed = prevLock;
    } catch {
      trustedSeed = undefined;
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), "bounded-lock-"));
  try {
    for (const [dir, manifest] of manifests) {
      mkdirSync(join(scratch, dir), { recursive: true });
      writeFileSync(join(scratch, manifestPath(dir)), serializeManifest(manifest));
    }
    if (trustedSeed !== undefined) writeFileSync(join(scratch, LOCKFILE), trustedSeed);
    try {
      maker(scratch);
    } catch (error) {
      const detail = error instanceof Error ? (String((error as { stderr?: unknown }).stderr ?? "").trim() || error.message) : String(error);
      throw new Error(`${LOCKFILE} cannot be produced: \`bun install --lockfile-only\` failed (${detail.split("\n").slice(-3).join(" ")}); ` +
        "it needs bun on PATH and the registry (or bun's cache) reachable");
    }
    const lockPath = join(scratch, LOCKFILE);
    if (!existsSync(lockPath)) throw new Error(`${LOCKFILE} cannot be produced: bun wrote no lockfile`);
    const lock = readFileSync(lockPath, "utf8");
    const problems = bunLockProblems(lock, manifests);
    if (problems.length > 0) throw new Error(`the ${LOCKFILE} bun produced does not verify: ${problems.join("; ")}`);
    return { lock, fingerprint: lockFingerprint(lock) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- init --------------------------------------------------------------------------

/**
 * Write the manifests, tsconfig.json, lockfile, rendered root config files
 * and shipped files into a freshly initialized project. Everything is
 * computed first; a file an earlier initializer already wrote is refused,
 * except the root config files the core copied verbatim, which are
 * rewritten with their `{{project}}` filled.
 */
export function writeProjectPackage(
  project: string,
  agentRoot: string,
  name: string = DEFAULT_PROJECT_NAME,
  maker: LockfileMaker = bunLockfileMaker,
): void {
  const packs = readProjectPacks(project);
  const packsDir = join(agentRoot, "packs");
  const generated = generatedManifests(project, packs, packsDir, name);
  const files = new Map<string, string>();
  for (const [dir, manifest] of generated.manifests) files.set(manifestPath(dir), serializeManifest(manifest));
  files.set(TSCONFIG, tsconfigFor(packs, packsDir));
  const resolved = lockfileFor(generated.manifests, undefined, maker);
  files.set(LOCKFILE, resolved.lock);
  files.set(LOCK_FINGERPRINT, serializeLockFingerprint(resolved.fingerprint));
  const shipped = shippedFiles(packs, packsDir);
  for (const path of [...files.keys(), ...shipped.map((f) => f.path)]) {
    if (existsSync(join(project, path))) {
      throw new Error(`A project initializer wrote ${path}; it belongs to the ts pack's generated config (package ownership belongs to selected capability manifests)`);
    }
  }
  for (const [path, content] of [...files, ...configFiles(packs, packsDir, name)]) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), content);
  }
  for (const { path, source } of shipped) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    copyFileSync(source, join(project, path));
  }
}

if (isMainModule(import.meta.url)) {
  const [project, agentRoot, name] = process.argv.slice(2);
  if (!project || !agentRoot) throw new Error("usage: project-package <project> <harness source root> [<project name>]");
  writeProjectPackage(resolve(project), resolve(agentRoot), name === undefined ? DEFAULT_PROJECT_NAME : checkedProjectName(name));
}
