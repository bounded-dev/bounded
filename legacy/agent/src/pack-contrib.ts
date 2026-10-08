// Data contributions are read only from the project's selected packs.
// Missing or malformed selected manifests refuse the check rather than
// silently weakening policy. An absent optional field contributes nothing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PathLayout, WriteProtection } from "./path-policy.ts";
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
  return contractFileSuffixesFor(readProjectPacks(cwd), packsDir);
}

/** contractFileSuffixes() for an explicit composition. */
export function contractFileSuffixesFor(packs: readonly string[], packsDir?: string): string[] {
  const suffixes = mergedContribution("contractFileSuffixes", packs, packsDir);
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

/** The project-relative globs of contract files for an explicit composition:
 *  `<root>/**\/*<suffix>` for each composed source root and contract suffix
 *  (ADRs 2026-052, 2026-056). No root, or no suffix, means no contract file. */
export function contractGlobsFor(packs: readonly string[], packsDir?: string): string[] {
  const roots = sourceRootsFor(packs, packsDir);
  const suffixes = contractFileSuffixesFor(packs, packsDir);
  return roots.flatMap((root) => suffixes.map((suffix) => `${root}/**/*${suffix}`));
}

/** contractGlobsFor() for this project's composition (throws when unreadable). */
export function contractGlobs(cwd: string, packsDir?: string): string[] {
  return contractGlobsFor(readProjectPacks(cwd), packsDir);
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
 * Everything the path policy needs to tell the sides apart (ADRs 2026-056…058),
 * each field read independently so one bad field closes only what it decides.
 * A host passes this to decide() (spread into its Ctx) and to ownerOfPath().
 */
export function pathLayoutOrUnreadable(cwd: string, packsDir?: string): PathLayout {
  return {
    sourceRoots: sourceRootsOrUnreadable(cwd, packsDir),
    contractGlobs: contractGlobsOrUnreadable(cwd, packsDir),
    testSuffixes: testFileSuffixesOrUnreadable(cwd, packsDir),
    generatedGlobs: generatedFileGlobsOrUnreadable(cwd, packsDir),
  };
}

/** pathLayoutOrUnreadable() for an explicit composition, strict: throws on
 *  any invalid field. For gates and tests that already hold the pack list. */
export function pathLayoutFor(packs: readonly string[], packsDir?: string): PathLayout {
  return {
    sourceRoots: sourceRootsFor(packs, packsDir),
    contractGlobs: contractGlobsFor(packs, packsDir),
    testSuffixes: testFileSuffixesFor(packs, packsDir),
    generatedGlobs: generatedFileGlobsFor(packs, packsDir),
  };
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

/** The data socket naming which project command restores a project's
 *  generated config (ADR 2026-072). Its consumer is `bounded lead sync-config`. */
export const CONFIG_SYNC_SOCKET = "projectConfigSyncCommand";

/**
 * The one project command that restores the composition's generated config:
 * the composed pack that names it in `projectConfigSyncCommand`, and the
 * command's name. Refuses, naming the pack, a value that is not a non-empty
 * string or names a command no composed pack provides; refuses none, and
 * more than one.
 */
export function projectConfigSyncCommand(packs: readonly string[], packsDir?: string): { readonly pack: string; readonly command: string } {
  const named = contributionsByPack(CONFIG_SYNC_SOCKET, packs, packsDir);
  if (named.length === 0) throw new Error("no composed capability restores project config");
  if (named.length > 1) {
    throw new Error(`more than one composed capability restores project config (${named.map((n) => `'${n.pack}'`).join(", ")})`);
  }
  const { pack, value } = named[0]!;
  if (typeof value !== "string" || value === "") throw new Error(`Selected pack '${pack}' ${CONFIG_SYNC_SOCKET} must be a non-empty command name`);
  const provided = new Set<string>();
  for (const { value: commands } of contributionsByPack("projectCommands", packs, packsDir)) {
    if (commands !== null && typeof commands === "object" && !Array.isArray(commands)) for (const name of Object.keys(commands)) provided.add(name);
  }
  if (!provided.has(value)) throw new Error(`Selected pack '${pack}' ${CONFIG_SYNC_SOCKET} names '${value}', which no composed pack's projectCommands provides`);
  return { pack, command: value };
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

// --- Layout sockets (ADRs 2026-056, 2026-057, 2026-058) ----------------------
//
// Three data fields tell the core where a project's source lives, which of
// its files are test-side, and which are generated. The core names none of
// them: with no contributor there is no source root (so no role writes
// source and no file is a contract), no test-side file and no generated
// file. Every reader validates strictly and throws; each `…OrUnreadable`
// variant returns `"unreadable"` instead, which consumers treat fail-closed.

const RESERVED_DIRS = new Set([".git", ".bounded"]);
const LITERAL_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Does one root glob's segment list match a path prefix of the other's?
 *  `*` matches any one literal segment; case is ignored. */
function rootsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === "*" || b[i] === "*") continue;
    if (a[i]!.toLowerCase() !== b[i]!.toLowerCase()) return false;
  }
  return true;
}

/**
 * `sourceRoots` (ADR 2026-056): project-relative directory globs under which
 * roles author source, e.g. `packages/*\/lib`. Each segment is a literal name
 * or exactly `*` (one directory level); the first segment is literal; no
 * `**`, partial wildcard, `.`/`..`, leading or trailing `/`, and no `.git` or
 * `.bounded` segment. Two roots where one could contain the other are
 * refused, so every path has at most one root. Sorted, deduplicated.
 */
export function sourceRootsFor(packs: readonly string[], packsDir?: string): string[] {
  const roots = mergedContribution("sourceRoots", packs, packsDir);
  const split = roots.map((root) => root.split("/"));
  roots.forEach((root, i) => {
    const segments = split[i]!;
    const valid = LITERAL_SEGMENT.test(segments[0]!) &&
      segments.every((s) => s === "*" || (LITERAL_SEGMENT.test(s) && s !== "." && s !== "..")) &&
      !segments.some((s) => RESERVED_DIRS.has(s.toLowerCase()));
    if (!valid) {
      throw new Error(`sourceRoots entry '${root}' must be a relative directory glob of literal segments and ` +
        "whole-segment '*', with a literal first segment and nothing under .git or .bounded");
    }
    for (let j = 0; j < i; j++) {
      if (rootsOverlap(segments, split[j]!)) {
        throw new Error(`sourceRoots entries '${roots[j]}' and '${root}' overlap — every path must have at most one source root`);
      }
    }
  });
  return roots;
}

/** sourceRootsFor() for this project's composition (throws when unreadable). */
export function sourceRoots(cwd: string, packsDir?: string): string[] {
  return sourceRootsFor(readProjectPacks(cwd), packsDir);
}

/** sourceRoots() for a host's path gate: `"unreadable"` on any failure. */
export function sourceRootsOrUnreadable(cwd: string, packsDir?: string): readonly string[] | "unreadable" {
  try {
    return sourceRoots(cwd, packsDir);
  } catch {
    return "unreadable";
  }
}

/**
 * The concrete source root a project-relative path lies under (e.g.
 * `packages/billing/lib` for `packages/billing/lib/model/x.ext` and the
 * root `packages/*\/lib`), or undefined. The path itself is inside the root only
 * when it is strictly deeper; a root directory is not inside itself. Case is
 * ignored, as everywhere in the path policy; the returned prefix keeps the
 * path's own spelling.
 */
export function sourceRootOf(path: string, roots: readonly string[]): string | undefined {
  const segments = path.split("/");
  for (const root of roots) {
    const rootSegments = root.split("/");
    if (segments.length <= rootSegments.length) continue;
    if (rootSegments.every((s, i) => s === "*" || s.toLowerCase() === segments[i]!.toLowerCase())) {
      return segments.slice(0, rootSegments.length).join("/");
    }
  }
  return undefined;
}

const DOTTED_SUFFIX = /^[._][a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/**
 * `testFileSuffixes` (ADR 2026-057): file-name suffixes that make a file
 * test-side, e.g. `.test.ext`. Lowercase, at least two parts, the first
 * opening with a dot or an underscore (`.test.ext`, `_test.ext`: test
 * runners collect both) and the rest dotted, so a bare language extension can
 * never make every file test-side; dash allowed inside a part
 * (`.test-support.ext`). A suffix that ends with a composed
 * contract suffix, or that a contract suffix ends with, is refused: a file
 * cannot be both a contract and a test.
 */
export function testFileSuffixesFor(packs: readonly string[], packsDir?: string): string[] {
  const suffixes = mergedContribution("testFileSuffixes", packs, packsDir);
  const contracts = mergedContribution("contractFileSuffixes", packs, packsDir);
  for (const suffix of suffixes) {
    if (!DOTTED_SUFFIX.test(suffix)) {
      throw new Error(`testFileSuffixes entry '${suffix}' must be a lowercase suffix of at least two parts, such as '.test.ext' or '_test.ext'`);
    }
    const clash = contracts.find((contract) => contract.endsWith(suffix) || suffix.endsWith(contract));
    if (clash !== undefined) {
      throw new Error(`testFileSuffixes entry '${suffix}' overlaps the contract suffix '${clash}' — a file cannot be both`);
    }
  }
  return suffixes;
}

/** testFileSuffixesFor() for this project's composition (throws when unreadable). */
export function testFileSuffixes(cwd: string, packsDir?: string): string[] {
  return testFileSuffixesFor(readProjectPacks(cwd), packsDir);
}

/** testFileSuffixes() for a host's path gate: `"unreadable"` on any failure. */
export function testFileSuffixesOrUnreadable(cwd: string, packsDir?: string): readonly string[] | "unreadable" {
  try {
    return testFileSuffixes(cwd, packsDir);
  } catch {
    return "unreadable";
  }
}

/** Does a path's file name end in one of the test suffixes? Case is ignored. */
export function hasTestFileSuffix(path: string, suffixes: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return suffixes.some((suffix) => lower.endsWith(suffix));
}

const GLOB_SEGMENT = /^[A-Za-z0-9._*-]+$/;

/**
 * `generatedFileGlobs` (ADR 2026-058): project-relative path globs of files
 * that only generators write. Segments are literal names, names with `*`
 * (any run of characters inside one segment), or exactly `**` (any number of
 * segments). Refused: `?`, `[`, `{`, `!`, escapes, `.`/`..`, a leading or
 * trailing `/`, a `***` run, a `.git` or `.bounded` segment, and a glob with
 * no literal character at all (`**\/*` would generate the whole project).
 */
export function generatedFileGlobsFor(packs: readonly string[], packsDir?: string): string[] {
  const globs = mergedContribution("generatedFileGlobs", packs, packsDir);
  for (const glob of globs) {
    const segments = glob.split("/");
    const valid = segments.every((s) => GLOB_SEGMENT.test(s) && s !== "." && s !== ".." &&
        (s === "**" || !s.includes("**")) && !RESERVED_DIRS.has(s.toLowerCase())) &&
      segments.some((s) => /[^*]/.test(s));
    if (!valid) {
      throw new Error(`generatedFileGlobs entry '${glob}' must be a relative path glob of names, '*' inside a segment ` +
        "and whole-segment '**', with at least one literal character and nothing under .git or .bounded");
    }
  }
  return globs;
}

/** generatedFileGlobsFor() for this project's composition (throws when unreadable). */
export function generatedFileGlobs(cwd: string, packsDir?: string): string[] {
  return generatedFileGlobsFor(readProjectPacks(cwd), packsDir);
}

/** generatedFileGlobs() for a host's path gate: `"unreadable"` on any failure. */
export function generatedFileGlobsOrUnreadable(cwd: string, packsDir?: string): readonly string[] | "unreadable" {
  try {
    return generatedFileGlobs(cwd, packsDir);
  } catch {
    return "unreadable";
  }
}

/** A case-insensitive matcher over validated project-relative path globs:
 *  `*` stays inside one segment; a whole `**` segment spans zero or more
 *  segments, or one or more when it is the last segment (`docs/**` matches
 *  everything below `docs/`, not `docs` itself). */
export function pathGlobMatcher(globs: readonly string[]): (path: string) => boolean {
  const patterns = globs.map((glob) => {
    const segments = glob.split("/");
    let body = "";
    segments.forEach((segment, i) => {
      const last = i === segments.length - 1;
      if (segment === "**") {
        body += last ? "[^/].*" : "(?:[^/]+/)*";
        return;
      }
      body += segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + (last ? "" : "/");
    });
    return new RegExp(`^${body}$`, "i");
  });
  return (path) => patterns.some((pattern) => pattern.test(path));
}
