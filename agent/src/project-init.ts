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
  generatedFileGlobsFor, mergedContribution, projectCommandNames, projectConfigSources, projectIgnoreRules, sourceRootsFor,
} from "./pack-contrib.ts";
import { COMPOSITION_FILE, writeProjectPacks } from "./project-composition.ts";
import { lockFor, sourceLockPath, type RuntimePackage } from "./runtime-lock.ts";
import { HOST_PACKAGE_DIRS, SETUP_COMMAND } from "./setup-state.ts";

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

function availablePacks(): Map<string, { dependsOnPacks: string[] }> {
  const known = new Map<string, { dependsOnPacks: string[] }>();
  for (const entry of readdirSync(join(agentRoot, "packs"), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z][a-z0-9-]*$/.test(entry.name)) continue;
    const manifestPath = join(agentRoot, "packs", entry.name, "contrib.json");
    if (!existsSync(manifestPath) || !existsSync(join(agentRoot, "packs", entry.name, "pack.ts"))) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependsOnPacks?: unknown };
    const deps = manifest.dependsOnPacks ?? [];
    if (!Array.isArray(deps) || deps.some((x) => typeof x !== "string" || !/^[a-z][a-z0-9-]*$/.test(x))) {
      throw new Error(`Capability '${entry.name}' has invalid dependsOnPacks`);
    }
    known.set(entry.name, { dependsOnPacks: deps });
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

/** The TN README's example `contracts:` entry: a file with the composed
 *  packs' contract suffix (ADR 2026-052) under a composed source root (ADR
 *  2026-056), each `*` segment named `example`. The root is the first, in
 *  sorted order, that some composed generated-file glob reaches into: the
 *  root the design drives, where contracts live. With none, the first root.
 *  An empty list when no pack contributes a suffix or a root. */
export function exampleContracts(packs: readonly string[]): string[] {
  const packsDir = join(agentRoot, "packs");
  const suffix = mergedContribution("contractFileSuffixes", packs, packsDir)[0];
  const roots = sourceRootsFor(packs, packsDir);
  if (suffix === undefined || roots.length === 0) return ["contracts: []"];
  const globs = generatedFileGlobsFor(packs, packsDir).map((glob) => glob.split("/"));
  const reachedByGlob = (root: string): boolean => {
    const segments = root.split("/");
    return globs.some((glob) => glob.length > segments.length &&
      segments.every((segment, i) => glob[i] === segment || (segment === "*" && glob[i] === "*")));
  };
  const root = roots.find(reachedByGlob) ?? roots[0]!;
  const dir = root.split("/").map((segment) => (segment === "*" ? "example" : segment)).join("/");
  return ["contracts:", `  - ${dir}/example/example${suffix}`];
}

/** Every installed capability, in name order: the selection `bounded init`
 *  makes when none is named. The installed set is the harness's one stack, so
 *  composing all of it gives a project that stack's full shape. */
export function defaultSelection(): readonly string[] {
  return [...availablePacks().keys()].sort();
}

/** The project's name, from its directory's name: lowercase letters, digits
 *  and dashes. Undefined when nothing usable is left, so the manifest writer
 *  falls back to its own default. */
export function projectNameOf(target: string): string | undefined {
  const candidate = basename(resolve(target)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9][a-z0-9-]*$/.test(candidate) ? candidate : undefined;
}

function shipsInitFiles(pack: string): boolean {
  const raw = JSON.parse(readFileSync(join(agentRoot, "packs", pack, "contrib.json"), "utf8")) as Record<string, unknown>;
  const configs = raw["projectConfigFiles"];
  const shipped = raw["projectShippedFiles"];
  return (Array.isArray(configs) && configs.length > 0) ||
    (shipped !== null && typeof shipped === "object" && Object.keys(shipped).length > 0);
}

function scaffolderFor(packs: readonly string[]): readonly { pack: string; script: string }[] {
  const scripts = packScripts(packs, "projectInitScripts");
  if (scripts.length === 0) throw new Error("This selection cannot yet scaffold a complete new project; choose a capability with a project initializer");
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
  // A pack whose whole init-time share is files it ships (config such as a
  // compose file, or checks) needs no initializer of its own: everything
  // else it contributes is generated from the design later.
  for (const pack of packs) if (shipsInitFiles(pack)) covered.add(pack);
  const unsupported = packs.filter((pack) => !covered.has(pack));
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

function harnessPackageFor(harnessRoot: string): RuntimePackage {
  const sourcePkg = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8")) as RuntimePackage;
  const sourceLock = JSON.parse(readFileSync(sourceLockPath(agentRoot), "utf8")) as { packages: Record<string, { version?: string }> };
  const names = new Set<string>();
  // A pack's reference/ files are content copied into projects, never harness
  // code: their imports are the project's dependencies, not the runtime's.
  for (const path of walk(harnessRoot).filter((path) => path.endsWith(".ts") && !/^packs\/[^/]+\/reference\//.test(path))) {
    const source = withoutTemplateText(readFileSync(join(harnessRoot, path), "utf8"));
    const imports = source.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[^;\n]*?\s+from\s+)?["']([^"']+)["']/gm);
    for (const match of imports) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
      if (!/^(@[a-z0-9-]+\/[a-z0-9._-]+|[a-z0-9._-]+)/i.test(specifier)) continue;
      names.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
    }
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
  for (const pack of packs) copyTree(join(agentRoot, "packs", pack), join(harnessRoot, "packs", pack), omit);
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
    "A dependent ticket needs a reviewed, frozen TN before its design is published.",
    "The team lead selects the ticket for this worktree before the architect starts; existing direct launchers may set `BOUNDED_TICKET` explicitly.",
    "Change `status: draft` to `status: active` when the reviewed design is agreed;",
    "the design gate will not freeze a draft note.",
    "A superseded TN uses a Markdown link such as `[TN-25](TN-25.md)` to each",
    "successor note; other tickets may have no TN.", "",
    "Example front matter for issue 24:", "",
    "```yaml", "---", "issue: 24", "status: draft",
    ...exampleContracts(packs), "---", "```", "",
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

function planFromStage(stage: string, host: InitHost, packs: readonly string[]): InitPlan {
  const release = sourceRelease();
  const createdFiles = fileHashes(stage);
  const files = Object.fromEntries(Object.entries(createdFiles).filter(([path]) =>
    path.startsWith(".bounded/harness/") || path === COMPOSITION_FILE ||
    path === "AGENTS.md" || path === "CLAUDE.md" || path.startsWith(".claude/") || path.startsWith(".pi/"),
  ));
  const content = { schemaVersion: 1 as const, host, packs, ...release, createdFiles, files };
  return { ...content, digest: sha(JSON.stringify(content)) };
}

function existingPlan(target: string, host: InitHost, requested: readonly string[]): InitPlan | undefined {
  const manifest = join(target, MANIFEST);
  if (!existsSync(manifest)) return undefined;
  const previous = JSON.parse(readFileSync(manifest, "utf8")) as InitPlan;
  const packs = closure(requested);
  if (previous.schemaVersion !== 1 || previous.host !== host || JSON.stringify(previous.packs) !== JSON.stringify(packs) ||
      !previous.files || !previous.createdFiles || typeof previous.digest !== "string") {
    throw new Error("Existing installation differs from this selection; bounded update is required");
  }
  const { digest: _digest, ...content } = previous;
  if (sha(JSON.stringify(content)) !== previous.digest) throw new Error("Installation manifest is invalid or changed");
  for (const [path, hash] of Object.entries(previous.files)) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(path) || path.includes("..") || path.startsWith("/")) throw new Error("Installation manifest contains an unsafe path");
    const absolute = join(target, path);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile() || sha(readFileSync(absolute)) !== hash) {
      throw new Error(`Installed file changed: ${path}; bounded update is required`);
    }
  }
  return previous;
}

export function describeInit(): object {
  return {
    command: "bounded init", writes: false,
    agentConversation: {
      openingQuestion: "What kind of application are you trying to build?",
      guidance: [
        "Ask about the product in plain language before discussing implementation choices.",
        "Learn its users, main workflows, and whether it needs a user interface, server, or persistent data. Ask focused follow-ups only where the answer changes the plan.",
        "Use the implementation options below privately to infer a capability selection. Do not ask the user to choose pack names or present this list as a menu.",
        "Use the agent host already running this conversation; do not ask the user to select another agent.",
        "Plan the complete inferred selection before proposing installation. A capability with its own initializer may still be incompatible with another selected capability.",
        "If the complete application cannot be scaffolded, explain the gap in product terms and stop. Do not silently omit a required part of the application.",
        "When a complete plan succeeds, explain what Bounded will create in plain language and review the plan before applying its digest.",
      ],
    },
    hosts: ["pi", "claude-code"],
    defaultSelection: defaultSelection(),
    implementationOptions: [...availablePacks()].map(([name, pack]) => ({ name, requires: pack.dependsOnPacks, hasProjectInitializer: scaffolderAvailable(name) })),
    next: "Ask the opening product question first. After inferring the complete selection, run bounded init --host <current-host> --pack <capability> [--pack <capability>...] to validate and review a plan. Omitting --pack selects defaultSelection, every installed capability.",
  };
}

function scaffolderAvailable(pack: string): boolean {
  const raw = JSON.parse(readFileSync(join(agentRoot, "packs", pack, "contrib.json"), "utf8")) as { projectInitScripts?: unknown };
  return Array.isArray(raw.projectInitScripts) && raw.projectInitScripts.length > 0;
}

export async function planInit(target: string, host: string, requested: readonly string[]): Promise<InitPlan> {
  if (host !== "pi" && host !== "claude-code") throw new Error(`Unsupported host '${host}'; choose pi or claude-code`);
  const prior = existingPlan(target, host, requested);
  if (prior) return prior;
  assertEmpty(target);
  const packs = closure(requested);
  const stage = mkdtempSync(join(tmpdir(), "bounded-init-plan-"));
  try { await assemble(stage, host, packs, projectNameOf(target)); return planFromStage(stage, host, packs); }
  finally { rmSync(stage, { recursive: true, force: true }); }
}

export async function applyInit(target: string, host: string, requested: readonly string[], reviewedDigest: string): Promise<InitPlan> {
  if (host !== "pi" && host !== "claude-code") throw new Error(`Unsupported host '${host}'`);
  if (!/^[a-f0-9]{64}$/.test(reviewedDigest)) throw new Error("Supply the SHA-256 digest of a reviewed plan");
  const previous = existingPlan(target, host, requested);
  if (previous) {
    if (previous.digest !== reviewedDigest) throw new Error("Existing installation differs from the reviewed plan; bounded update is required");
    return previous;
  }
  assertEmpty(target);
  const packs = closure(requested);
  const stage = mkdtempSync(join(tmpdir(), "bounded-init-apply-"));
  try {
    await assemble(stage, host, packs, projectNameOf(target));
    const plan = planFromStage(stage, host, packs);
    if (plan.digest !== reviewedDigest) throw new Error("Plan changed since review; run bounded init with the same options again");
    writeFileSync(join(stage, MANIFEST), JSON.stringify(plan, null, 2) + "\n");
    assertEmpty(target);
    mkdirSync(target, { recursive: true });
    const created: string[] = [];
    const directories: string[] = [];
    try {
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
      throw error;
    }
    return plan;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
