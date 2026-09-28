// Data contributions are read only from the project's selected packs.
// Missing or malformed selected manifests refuse the check rather than
// silently weakening policy. An absent optional field contributes nothing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WriteProtection } from "./path-policy.ts";
import { readProjectPacks } from "./project-composition.ts";

function defaultPacksDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "packs");
}

/**
 * Each selected pack's raw value for a data field, in composition order,
 * without executing packs. Consumers that need structured or ordered content
 * validate the shape themselves; an absent field contributes nothing.
 */
export function contributionsByPack(
  key: string,
  packs: readonly string[],
  packsDir = defaultPacksDir(),
): { readonly pack: string; readonly value: unknown }[] {
  const out: { pack: string; value: unknown }[] = [];
  const selected = new Set(packs);
  for (const pack of packs) {
    if (!/^[a-z][a-z0-9-]*$/.test(pack)) throw new Error(`Invalid pack name '${pack}'`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(packsDir, pack, "contrib.json"), "utf8"));
    } catch {
      throw new Error(`Selected pack '${pack}' has a missing or malformed contrib.json`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Selected pack '${pack}' must have an object contrib.json`);
    }
    const manifest = parsed as Record<string, unknown>;
    const dependencies = manifest.dependsOnPacks;
    if (dependencies !== undefined &&
        (!Array.isArray(dependencies) || dependencies.some((dep) => typeof dep !== "string" || !selected.has(dep)))) {
      throw new Error(`Selected pack '${pack}' has an invalid or unselected dependsOnPacks edge`);
    }
    if (manifest[key] !== undefined) out.push({ pack, value: manifest[key] });
  }
  return out;
}

/** Merge a data field from an explicit composition, without executing packs. */
export function mergedContribution(
  key: string,
  packs: readonly string[],
  packsDir = defaultPacksDir(),
): string[] {
  const out = new Set<string>();
  for (const { pack, value } of contributionsByPack(key, packs, packsDir)) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new Error(`Selected pack '${pack}' field '${key}' must be an array of nonempty strings`);
    }
    for (const item of value) out.add(item);
  }
  return [...out].sort();
}

/** Intake policy comes from this project's composition, never installed peers. */
export function specTechNouns(cwd: string, packsDir?: string): string[] {
  return mergedContribution("specTechNouns", readProjectPacks(cwd), packsDir);
}

/** Filename suffixes that mark a design contract, from this project's composed
 *  packs (ADR 2026-052). The core never names one: with no composed pack
 *  contributing a suffix, no file is recognised as a contract. */
export function contractFileSuffixes(cwd: string, packsDir?: string): string[] {
  const suffixes = mergedContribution("contractFileSuffixes", readProjectPacks(cwd), packsDir);
  for (const suffix of suffixes) {
    if (!/^\.[a-z0-9]+(?:\.[a-z0-9]+)*$/.test(suffix)) {
      throw new Error(`contractFileSuffixes entry '${suffix}' must be a lowercase dotted filename suffix`);
    }
  }
  return suffixes;
}

/** Does a project-relative path end in one of the composed contract suffixes? */
export function hasContractSuffix(path: string, suffixes: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return suffixes.some((suffix) => lower.endsWith(suffix));
}

/** The project-relative globs of its contract files: `src/**\/*<suffix>`
 *  for each composed suffix (ADR 2026-052). */
export function contractGlobs(cwd: string, packsDir?: string): string[] {
  return contractFileSuffixes(cwd, packsDir).map((suffix) => `src/**/*${suffix}`);
}

/** contractGlobs() for a host's path gate: an unreadable composition is
 *  `"unreadable"`, which the pure policy treats fail-closed. */
export function contractGlobsOrUnreadable(cwd: string, packsDir?: string): readonly string[] | "unreadable" {
  try {
    return contractGlobs(cwd, packsDir);
  } catch {
    return "unreadable";
  }
}

/**
 * The command names the composed packs' `projectCommands` declare, sorted,
 * for a project-local launcher's dispatch. A name must be a plain lowercase
 * word, may not shadow one of the launcher's own `reserved` subcommands, and
 * may be declared by one pack only (packs/command.ts refuses a duplicate at
 * run time; this refuses it before a launcher is written).
 */
export function projectCommandNames(packs: readonly string[], reserved: readonly string[], packsDir?: string): string[] {
  const names = new Set<string>();
  for (const { pack, value } of contributionsByPack("projectCommands", packs, packsDir)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Selected pack '${pack}' projectCommands must be an object`);
    }
    for (const name of Object.keys(value)) {
      if (!/^[a-z][a-z0-9-]*$/.test(name) || reserved.includes(name) || names.has(name)) {
        throw new Error(`Selected pack '${pack}' projectCommands entry '${name}' must be a unique lowercase name that no core subcommand uses`);
      }
      names.add(name);
    }
  }
  return [...names].sort();
}

/** A config-names field (ADR 2026-054): file-name globs, `*` the only
 *  wildcard, never a path. */
export function fileNameGlobs(field: string, packs: readonly string[], packsDir?: string): string[] {
  const names = mergedContribution(field, packs, packsDir);
  for (const name of names) {
    if (!/^[A-Za-z0-9._*-]+$/.test(name) || name === "." || name === "..") {
      throw new Error(`${field} entry '${name}' must be a file name, optionally with '*'`);
    }
  }
  return names;
}

/** A case-insensitive matcher for validated file-name globs (`*` only). */
export function fileNameMatcher(names: readonly string[]): (name: string) => boolean {
  const patterns = names.map((name) =>
    new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i"));
  return (name) => patterns.some((pattern) => pattern.test(name));
}

/**
 * `projectDependencyDirs` (ADR 2026-054): the directory names the stack's
 * tools resolve installed dependencies from. The drift check skips them only
 * at the project root, and a nested one anywhere is drift and write-denied
 * for every role, because it is resolved before the root's. Literal names.
 */
export function projectDependencyDirs(packs: readonly string[], packsDir?: string): string[] {
  const names = mergedContribution("projectDependencyDirs", packs, packsDir);
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
      throw new Error(`projectDependencyDirs entry '${name}' must be a literal directory name`);
    }
  }
  return names;
}

/** The names the composed packs protect at any depth, for the path policy. */
export function writeProtection(cwd: string, packsDir?: string): WriteProtection {
  const packs = readProjectPacks(cwd);
  return {
    dirNames: projectDependencyDirs(packs, packsDir),
    fileNames: fileNameGlobs("projectNestedConfigNames", packs, packsDir),
  };
}

/** writeProtection() for a host's path gate: an unreadable composition is
 *  `"unreadable"`, which the pure policy treats fail-closed. */
export function writeProtectionOrUnreadable(cwd: string, packsDir?: string): WriteProtection | "unreadable" {
  try {
    return writeProtection(cwd, packsDir);
  } catch {
    return "unreadable";
  }
}

const RESERVED_SEGMENTS = new Set([".git", ".bounded"]);

/**
 * `.gitignore` lines the composed packs add for what setup and builds
 * produce (ADR 2026-051). The core appends its own rules for `.bounded` after
 * these, so a pack rule must never reach `.bounded` or `.git`, nor re-include
 * anything. The accepted form is decidable from the text alone: anchored to
 * the project root (leading `/`), a literal first segment that is not `.git`
 * or `.bounded`, later segments of names and `*` only, an optional trailing
 * `/`. That refuses negation (`!`), escapes, character classes, `..`, and
 * every unanchored rule (which git matches at any depth, `.bounded` included).
 */
export function projectIgnoreRules(packs: readonly string[], packsDir?: string): string[] {
  const rules = mergedContribution("projectIgnoreRules", packs, packsDir);
  for (const rule of rules) {
    const body = rule.replace(/\/$/, "");
    const parts = body.split("/").slice(1);
    const valid = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._*-]+)*\/?$/.test(rule) &&
      !parts.some((part) => part === "." || part === "..") &&
      !RESERVED_SEGMENTS.has(parts[0]!.toLowerCase());
    if (!valid) {
      throw new Error(`projectIgnoreRules entry '${rule}' must be a root-anchored path such as '/build/' with a literal ` +
        "first segment, no negation, and nothing under .git or .bounded");
    }
  }
  return rules;
}

/** One project config file a composed pack ships verbatim: its source inside
 *  the pack and the project-root file name it lands at. */
export interface ProjectConfigSource {
  readonly pack: string;
  readonly source: string;
  readonly target: string;
}

/**
 * The composed packs' `projectConfigFiles` (ADR 2026-051, ADR 2026-054):
 * pack-relative reference files copied to the project root under their own
 * file name. Read without executing packs; the initializer copies them and a
 * pack's config sync and drift check compare against them. Two packs landing
 * on one root name is refused.
 */
export function projectConfigSources(packs: readonly string[], packsDir = defaultPacksDir()): ProjectConfigSource[] {
  const out: ProjectConfigSource[] = [];
  const targets = new Set<string>();
  for (const { pack, value } of contributionsByPack("projectConfigFiles", packs, packsDir)) {
    if (!Array.isArray(value) || value.some((path) =>
      typeof path !== "string" || !/^[a-z0-9/._-]+$/.test(path) || path.includes("..") || path.startsWith("/"))) {
      throw new Error(`Capability '${pack}' has invalid projectConfigFiles`);
    }
    for (const path of value as string[]) {
      const target = path.slice(path.lastIndexOf("/") + 1);
      if (targets.has(target)) throw new Error(`Project config collision: ${pack}/${path}`);
      targets.add(target);
      out.push({ pack, source: join(packsDir, pack, path), target });
    }
  }
  return out;
}
