// Project setup state shared by every host entry (ADR 2026-048, ADR 2026-051).
//
// A fresh clone runs this before any package is installed, so it and every
// module it imports use Node builtins only. Both host entries (the Claude Code
// bootstrap hook and the pi bootstrap extension) and the lead policy read the
// same answers from here: whether dependencies are ready, whether setup may
// run, which local reads are safe before setup, and how setup runs.
//
// Where the line sits: the harness is itself a Node program, so installing
// ITS runtime under .bounded/harness is the core's own business. The
// project's dependencies belong to the composed packs, which contribute the
// commands and the probe paths as data (projectSetupCommands,
// projectSetupProbes). The core runs what they contribute and names none of it.

import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { guardLogPath, logGuardEvent, RUN_START_GUARD } from "./guard-log.ts";
import { isMainModule } from "./is-main-module.ts";
import { contributionsByPack, mergedContribution } from "./pack-contrib.ts";
import { readProjectPacks } from "./project-composition.ts";

export const SETUP_COMPLETE_RELATIVE = ".bounded/setup-complete";
export const INSTALLATION_RELATIVE = ".bounded/installation.json";
export const HARNESS_RELATIVE = ".bounded/harness";
/** Where pi installs the project's own pi packages (its settings' "packages").
 *  The host's runtime state, not project config: ignored by git and skipped by
 *  the config drift check. */
export const HOST_PACKAGE_DIRS = [".pi/npm", ".pi/git"] as const;
/** The one shell command a host without a setup tool may run before setup. */
export const SETUP_COMMAND = "bash .bounded/harness/scripts/bounded setup";
export const SETUP_COMMANDS_SOCKET = "projectSetupCommands";
export const SETUP_PROBES_SOCKET = "projectSetupProbes";
export const IGNORE_RULES_SOCKET = "projectIgnoreRules";

/** The harness's own runtime install: it is a Node program with a committed lockfile. */
const HARNESS_RUNTIME = { command: "npm", args: ["ci"], probe: "node_modules/.package-lock.json" } as const;
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RELATIVE_PATH = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

export interface SetupStep {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface SetupPlan {
  readonly steps: readonly SetupStep[];
  /** Absolute paths that exist only after every step succeeded. */
  readonly probes: readonly string[];
}

function safeRelative(path: string): boolean {
  return RELATIVE_PATH.test(path) && !path.split("/").some((part) => part === "." || part === "..");
}

/** Composed project setup, then the harness runtime. Throws on malformed contributions. */
export function setupPlan(project: string): SetupPlan {
  const root = resolve(project);
  const harness = join(root, HARNESS_RELATIVE);
  const packs = readProjectPacks(root);
  const packsDir = join(harness, "packs");
  const steps: SetupStep[] = [];
  for (const { pack, value } of contributionsByPack(SETUP_COMMANDS_SOCKET, packs, packsDir)) {
    if (!Array.isArray(value) || value.some((argv) => !Array.isArray(argv) || argv.length === 0 ||
        argv.some((word) => typeof word !== "string" || word === "" || word.includes("\0")) || !PROGRAM.test(argv[0] as string))) {
      throw new Error(`Selected pack '${pack}' field '${SETUP_COMMANDS_SOCKET}' must be a list of argv lists naming a program`);
    }
    for (const argv of value as string[][]) {
      steps.push({ label: `project (${pack})`, command: argv[0], args: argv.slice(1), cwd: root });
    }
  }
  const probes = mergedContribution(SETUP_PROBES_SOCKET, packs, packsDir);
  const bad = probes.find((probe) => !safeRelative(probe));
  if (bad !== undefined) throw new Error(`Setup probe '${bad}' must be a plain project-relative path`);
  steps.push({ label: "local harness", command: HARNESS_RUNTIME.command, args: HARNESS_RUNTIME.args, cwd: harness });
  return { steps, probes: [...probes.map((probe) => join(root, probe)), join(harness, HARNESS_RUNTIME.probe)] };
}

/** True once setup recorded completion and every composed dependency tree is present. */
export function dependenciesReady(project: string): boolean {
  try {
    if (!existsSync(join(project, SETUP_COMPLETE_RELATIVE))) return false;
    return setupPlan(project).probes.every((probe) => existsSync(probe));
  } catch {
    return false;
  }
}

/**
 * No ticket has been designed or run here. Anything unreadable, and any
 * malformed guard-log line, counts as "a run may have started".
 */
export function beforeFirstRun(project: string): boolean {
  try {
    const state = join(project, ".bounded");
    if (existsSync(join(state, "active-ticket")) || existsSync(join(state, "contract-checksums.json"))) return false;
    const tickets = join(state, "tickets");
    if (existsSync(tickets) && readdirSync(tickets, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() && existsSync(join(tickets, entry.name, "contract-checksums.json")))) return false;
    const log = guardLogPath(project);
    if (!existsSync(log)) return true;
    for (const line of readFileSync(log, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const event: unknown = JSON.parse(line);
      if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
      if ((event as { guard?: unknown }).guard === RUN_START_GUARD) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A completed setup whose dependency trees are genuinely gone: at least one
 * composed probe is missing. A malformed composition is not a repair case.
 */
export function repairNeeded(project: string): boolean {
  try {
    if (!existsSync(join(project, SETUP_COMPLETE_RELATIVE))) return false;
    return setupPlan(project).probes.some((probe) => !existsSync(probe));
  } catch {
    return false;
  }
}

/**
 * Setup may run in an installed project before its first run, or afterwards
 * only to repair a completed setup whose dependency trees are missing. No role
 * may write the package manifest (ADR 2026-054), but re-running an installer
 * on demand would still run whatever it now says, so an intact setup is never
 * re-run (ADR 2026-051): reinstalling after a config sync is the user's
 * `bounded sync-config`, which runs the same composed commands (ADR 2026-054).
 */
export function setupPermitted(project: string): boolean {
  if (!existsSync(join(project, INSTALLATION_RELATIVE))) return false;
  return beforeFirstRun(project) || repairNeeded(project);
}

/** Why setup is refused, in one sentence every host shows the same way. */
export const SETUP_REFUSED =
  "team-lead: dependency setup is available only before the first run, or to repair a completed setup whose dependencies are missing";

export function markSetupComplete(project: string): void {
  if (!existsSync(join(project, INSTALLATION_RELATIVE))) {
    throw new Error("bounded setup requires an initialized project");
  }
  writeFileSync(join(project, SETUP_COMPLETE_RELATIVE), "complete\n");
}

export type SetupResult = { readonly ok: boolean; readonly summary: string };

const execFileAsync = promisify(execFile);

/** Run the composed setup, then record completion. Every outcome is logged. */
export async function runProjectSetup(
  project: string,
  options: { readonly host?: string; readonly signal?: AbortSignal } = {},
): Promise<SetupResult> {
  const root = resolve(project);
  const host = options.host === undefined ? {} : { host: options.host };
  const fail = (stage: string, why: string): SetupResult => {
    const summary = `team-lead: ${stage} dependency setup failed: ${why.slice(-1200)}`;
    logGuardEvent(root, { guard: "team-lead", verdict: "block", summary, detail: { ...host, kind: "setup", stage } });
    return { ok: false, summary };
  };
  if (!setupPermitted(root)) {
    const summary = SETUP_REFUSED;
    logGuardEvent(root, { guard: "team-lead", verdict: "block", summary, detail: { ...host, kind: "setup", stage: "permission" } });
    return { ok: false, summary };
  }
  let plan: SetupPlan;
  try {
    plan = setupPlan(root);
  } catch (error) {
    return fail("composed", error instanceof Error ? error.message : String(error));
  }
  for (const step of plan.steps) {
    try {
      await execFileAsync(step.command, [...step.args], { cwd: step.cwd, signal: options.signal, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      return fail(step.label, error instanceof Error ? error.message : String(error));
    }
  }
  const missing = plan.probes.filter((probe) => !existsSync(probe));
  if (missing.length > 0) {
    return fail("verification", `setup returned without ${missing.map((path) => relative(root, path)).join(", ")}`);
  }
  markSetupComplete(root);
  const summary = "team-lead: project and local harness dependencies installed from lockfiles";
  logGuardEvent(root, { guard: "team-lead", verdict: "pass", summary, detail: { ...host, kind: "setup" } });
  return { ok: true, summary };
}

// --- Reads permitted before setup --------------------------------------------

/**
 * One project-local read, in host-neutral terms. `path` is the file or
 * directory the call reads or searches (absent means the base directory when
 * `pathRequired` is false); `globs` are path patterns the call expands.
 */
export interface ProjectRead {
  readonly path: unknown;
  readonly pathRequired: boolean;
  /** A listing or search (it walks a directory tree) rather than a single read. */
  readonly search: boolean;
  readonly globs: readonly unknown[];
}

function within(root: string, target: string): string | undefined {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel;
}

/** Case-insensitive: macOS and Windows filesystems open `.GIT/config` as `.git/config`. */
const touchesGit = (path: string): boolean => path.split(/[\\/]/).some((part) => part.toLowerCase() === ".git");

/**
 * The project-relative path `path` names once every existing link on it is
 * resolved, or undefined when it resolves outside the project or into .git.
 * Components that do not exist yet are kept as written (they cannot be links);
 * a link that cannot be resolved (dangling, or a loop) is refused, because
 * writing through it would land wherever it points.
 */
export function resolvedProjectPath(project: string, path: string): string | undefined {
  try {
    if (path.includes("\0")) return undefined;
    const root = realpathSync(project);
    let existing = resolve(project, path);
    const tail: string[] = [];
    for (;;) {
      try {
        lstatSync(existing);
        break;
      } catch {
        const parent = dirname(existing);
        if (parent === existing) return undefined;
        tail.unshift(basename(existing));
        existing = parent;
      }
    }
    const rel = within(root, join(realpathSync(existing), ...tail));
    if (rel === undefined || touchesGit(rel)) return undefined;
    return rel === "" ? "." : rel;
  } catch {
    return undefined;
  }
}

/**
 * True when `path` exists inside the project once links are resolved, and
 * neither the path as written nor the resolved path passes through .git.
 */
export function insideProject(project: string, path: string): boolean {
  if (touchesGit(path) || !existsSync(path)) return false;
  return resolvedProjectPath(project, path) !== undefined;
}

const GLOB_META = /[*?[\]{}()!+@|]/;
const MAX_EXPANSIONS = 256;

/** Brace alternatives, expanded; undefined when a brace is unbalanced, holds a range, or expands too far. */
function expandBraces(pattern: string): string[] | undefined {
  const open = pattern.indexOf("{");
  if (open === -1) return pattern.includes("}") ? undefined : [pattern];
  let depth = 0;
  const cuts: number[] = [];
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { close = i; break; }
    else if (c === "," && depth === 1) cuts.push(i);
  }
  if (close === -1) return undefined;
  const body = pattern.slice(open + 1, close);
  if (body.includes("..")) return undefined; // a range could spell '.' or '/'
  const bounds = [open, ...cuts, close];
  const out: string[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const expanded = expandBraces(pattern.slice(0, open) + pattern.slice(bounds[k]! + 1, bounds[k + 1]) + pattern.slice(close + 1));
    if (expanded === undefined) return undefined;
    out.push(...expanded);
    if (out.length > MAX_EXPANSIONS) return undefined;
  }
  return out;
}

/**
 * One path segment of a glob as an anchored regular expression: `*` and `?`
 * as wildcards, `[...]` as a character class (`!` or `^` negates), anything
 * else literal. Undefined for a class that is unterminated, nests a bracket
 * (a POSIX class such as `[[:punct:]]`), or is not a valid range.
 */
function segmentRegex(segment: string): RegExp | undefined {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (c === "[") {
      let j = i + 1;
      let negate = false;
      if (segment[j] === "!" || segment[j] === "^") { negate = true; j++; }
      const start = j;
      if (segment[j] === "]") j++; // a leading ']' is a member
      while (j < segment.length && segment[j] !== "]") j++;
      if (j >= segment.length) return undefined;
      const body = segment.slice(start, j);
      if (body.includes("[")) return undefined;
      source += `[${negate ? "^/" : ""}${body.replace(/[\]\\^]/g, "\\$&")}]`;
      i = j;
    } else source += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`, "i");
  } catch {
    return undefined;
  }
}

/** Could this glob segment match a directory named .git, in any letter case? */
function segmentMayNameGit(segment: string): boolean {
  if (segment === "*" || segment === "**") return false; // matches everything, .git included; the root refusal covers it
  if (segment.startsWith(".") && GLOB_META.test(segment)) return true;
  const regex = segmentRegex(segment);
  return regex === undefined || regex.test(".git");
}

/**
 * True when a search pattern (a glob a read tool expands under the directory
 * it searches) stays inside that directory and cannot name .git. Absent is
 * contained; anything malformed is not. Fails closed on globs: a leading `!`
 * (negation), an extglob or regex-style group (`(`, `|`) is refused; after
 * brace expansion, no segment may be '..', no dot-segment may carry a glob
 * metacharacter (`.gi?`, `.git*`), and no segment may match `.git` in any
 * letter case (`.GIT`, `[.]git`, `?git`). Shared by every host and by the
 * pre-setup entry.
 */
export function searchPatternContained(pattern: unknown): boolean {
  if (pattern === undefined) return true;
  if (typeof pattern !== "string" || pattern === "") return false;
  if (isAbsolute(pattern) || pattern.startsWith("~") || pattern.includes("\\") || pattern.includes("\0")) return false;
  if (pattern.startsWith("!") || /[()|]/.test(pattern)) return false;
  const expanded = expandBraces(pattern);
  if (expanded === undefined) return false;
  return expanded.every((one) => !isAbsolute(one) && !one.startsWith("~") && !one.startsWith("!") &&
    one.split("/").every((part) => part !== ".." && !segmentMayNameGit(part)));
}

/**
 * Before setup the lead may only look around its own project, judged as the
 * full policy judges it afterwards (the architect's read zone, which
 * path-policy's decide() enforces; a test pins the two together): a read, a
 * listing, a content search, or a file search whose every path stays inside
 * the project and out of .git, once links are resolved. A listing or search
 * may not be rooted at the project root, because the tree it walks contains
 * .git (the read tools search hidden files). Anything malformed is refused.
 */
export function projectReadAllowed(project: string, base: string, read: ProjectRead): boolean {
  if (!insideProject(project, base)) return false;
  if (read.path === undefined && read.pathRequired) return false;
  if (read.path !== undefined && (typeof read.path !== "string" || read.path === "")) return false;
  const target = read.path === undefined ? base : resolve(base, read.path as string);
  if (!insideProject(project, target)) return false;
  if (read.search && resolvedProjectPath(project, target) === ".") return false;
  return read.globs.every(searchPatternContained);
}

// `bash .bounded/harness/scripts/bounded setup` lands here. The project is
// derived from this file's own location, never from the caller's cwd.
if (isMainModule(import.meta.url)) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  runProjectSetup(project, { host: process.argv[2] === "--host" ? process.argv[3] : undefined }).then((result) => {
    process[result.ok ? "stdout" : "stderr"].write(`${result.summary}\n`);
    process.exit(result.ok ? 0 : 1);
  }, (error: unknown) => {
    process.stderr.write(`team-lead: dependency setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
