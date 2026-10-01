// Project configuration is generated from the composed packs and the design,
// never written by a role (ADR 2026-054, ADR 2026-061, ADR 2026-062).
//
// In a project-local installation (`bounded init`), every package manifest
// (the root's and each workspace's), `bun.lock`, `tsconfig.json`, the
// composed packs' `projectConfigFiles` reference copies and their shipped
// files are a pure function of the composition, the design contracts and the
// TNs' `workspaces:` maps (project-package.ts). This module computes that
// function and compares the project against it.
//
// · Every gate and tool that runs the test runner, type-checker or bundler
//   (design, red, green, deliver, run-tests, typecheck, mutation-score, the
//   web render) calls `configDriftBlock` first, and the two spawning
//   primitives (runTests, typecheck) refuse through `configDriftReason`: a
//   changed, missing or extra config file is a BLOCK, whoever made it.
//   "Extra" covers the root (`projectConfigNames`) and, below it, the files
//   Bun and the type-checker read per directory (`projectNestedConfigNames`:
//   a nested package.json, tsconfig or bunfig.toml that is not a generated
//   workspace manifest), and any dependency directory (`projectDependencyDirs`),
//   `.git` or `.bounded` below the root, except the dependency directory
//   directly under a generated workspace, where Bun's isolated installs link
//   that workspace's dependencies. A nested config-named file that a composed
//   `generatedFileGlobs` entry covers belongs to its generator's own drift
//   check, not this one.
// · `bun.lock` must be the lockfile of exactly the generated manifests: its
//   workspaces match them and every pin resolves to exactly its version
//   (`bunLockProblems`, no network), including each entry's registry URL,
//   integrity and dependencies against the fingerprint of the clean
//   resolution recorded when bun produced it (.bounded/lockfile-fingerprint.json).
// · `sync-config` (the user's command, scripts/sync-config.ts) rewrites the
//   files from the same function, derives the lockfile when the old one no
//   longer verifies, then reinstalls through the composed packs' setup
//   commands when anything changed.
//
// A project that was not initialized by `bounded init` (an adopted repository,
// a global-harness arm) had its config written by someone else, so there is
// nothing generated to compare against: the check does not apply there, and
// the path gate alone keeps roles out of its config.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { GateResult } from "../../../src/gate-result.ts";
import { logGuardEvent } from "../../../src/guard-log.ts";
import {
  fileNameGlobs,
  fileNameMatcher,
  generatedFileGlobsFor,
  pathGlobMatcher,
  projectDependencyDirs,
} from "../../../src/pack-contrib.ts";
import { readProjectPacks } from "../../../src/project-composition.ts";
import { HARNESS_RELATIVE, HOST_PACKAGE_DIRS, INSTALLATION_RELATIVE, setupPlan, type SetupPlan } from "../../../src/setup-state.ts";
import {
  bunLockfileMaker,
  bunLockProblems,
  configFiles,
  generatedManifests,
  type FingerprintedLock,
  LOCK_FINGERPRINT,
  type LockFingerprint,
  LOCKFILE,
  lockfileFor,
  parseLockFingerprint,
  serializeLockFingerprint,
  type LockfileMaker,
  type Manifest,
  MANIFEST,
  manifestPath,
  type ProjectWorkspace,
  readProjectName,
  serializeManifest,
  shippedFiles,
  TSCONFIG,
  tsconfigFor,
} from "./project-package.ts";

export { LOCKFILE, MANIFEST };
/** Where the user runs the sync from, in a project-local installation. */
export const SYNC_COMMAND = "bash .bounded/harness/scripts/bounded sync-config";

/** The harness this module runs from: the checkout, or a project's `.bounded/harness`. */
export function harnessRootOf(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** Does the drift check apply? Only where the packs generated the config. */
export function configIsGenerated(project: string): boolean {
  return existsSync(join(project, INSTALLATION_RELATIVE));
}

/** The directories the nested walk never enters at the ROOT: version control
 *  and harness state. Below the root, either is drift. */
const CORE_ROOT_SKIP = [".git", ".bounded"] as const;
/** Host package installs (pi's `.pi/npm`, `.pi/git`) hold the host's own
 *  dependency trees; no stack tool reads them, so the walk never enters them. */
const HOST_SKIP: ReadonlySet<string> = new Set(HOST_PACKAGE_DIRS);

const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** What the composed packs generate, file by file, and how to judge the rest. */
export interface GeneratedConfig {
  /** The root manifest. */
  readonly pkg: Manifest;
  /** Every generated manifest by workspace directory (`""` is the root). */
  readonly manifests: ReadonlyMap<string, Manifest>;
  readonly workspaces: readonly ProjectWorkspace[];
  /** Project-relative path → exact bytes, every generated file except the lockfile. */
  readonly files: ReadonlyMap<string, string>;
  /** Does a root entry name count as project config? */
  readonly isConfig: (entry: string) => boolean;
  /** Does a file name count as project config at any depth below the root? */
  readonly isNestedConfig: (name: string) => boolean;
  /** Is a project path owned by a composed generator (`generatedFileGlobs`)? */
  readonly isGenerated: (path: string) => boolean;
  /** Directory names (lowercase) that are drift below the root: the core's
   *  `.git` and `.bounded`, and the packs' dependency directories. */
  readonly protectedDirs: ReadonlySet<string>;
  /** Dependency directory names (lowercase), expected directly under a workspace. */
  readonly dependencyDirs: ReadonlySet<string>;
}

export function generatedConfig(project: string, harnessRoot = harnessRootOf()): GeneratedConfig {
  const packsDir = join(harnessRoot, "packs");
  const packs = readProjectPacks(project);
  const generated = generatedManifests(project, packs, packsDir, readProjectName(project));
  const files = new Map<string, string>();
  for (const [dir, manifest] of generated.manifests) files.set(manifestPath(dir), serializeManifest(manifest));
  files.set(TSCONFIG, tsconfigFor(packs, packsDir));
  for (const [target, content] of configFiles(packs, packsDir, generated.name)) files.set(target, content);
  for (const { path, source } of shippedFiles(packs, packsDir)) files.set(path, readFileSync(source, "utf8"));
  const dependencyDirs = new Set(projectDependencyDirs(packs, packsDir).map((name) => name.toLowerCase()));
  return {
    pkg: generated.manifests.get("")!,
    manifests: generated.manifests,
    workspaces: generated.workspaces,
    files,
    isConfig: fileNameMatcher(fileNameGlobs("projectConfigNames", packs, packsDir)),
    isNestedConfig: fileNameMatcher(fileNameGlobs("projectNestedConfigNames", packs, packsDir)),
    isGenerated: pathGlobMatcher(generatedFileGlobsFor(packs, packsDir)),
    protectedDirs: new Set([...CORE_ROOT_SKIP, ...dependencyDirs]),
    dependencyDirs,
  };
}

export interface ConfigDrift {
  readonly path: string;
  readonly problem: string;
}

/** Nested problems below the root: config-named files no pack generates, and
 *  every protected directory except a dependency directory directly under a
 *  generated workspace. A protected directory is reported once and not
 *  entered. */
function nestedProblems(project: string, generated: GeneratedConfig, expected: ReadonlySet<string>): ConfigDrift[] {
  const out: ConfigDrift[] = [];
  const workspaceDirs = new Set(generated.workspaces.map((w) => w.dir.toLowerCase()));
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(project, rel), { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (HOST_SKIP.has(path)) continue;
      const lower = entry.name.toLowerCase();
      if (generated.protectedDirs.has(lower)) {
        if (generated.dependencyDirs.has(lower) && workspaceDirs.has(rel.toLowerCase())) continue;
        out.push({ path, problem: "a dependency, version-control or harness directory where none belongs, which the stack's tools would honour before the root's" });
      } else if (entry.isDirectory()) walk(path);
      else if (generated.isNestedConfig(entry.name) && !expected.has(path.toLowerCase()) && !generated.isGenerated(path)) {
        out.push({ path, problem: "no composed pack generates it" });
      }
    }
  };
  for (const entry of readdirSync(project, { withFileTypes: true })) {
    if (entry.isDirectory() && !generated.protectedDirs.has(entry.name.toLowerCase())) walk(entry.name);
  }
  return out;
}

/** Config present that no composed pack generates: root files by
 *  `projectConfigNames`, nested files and directories as above. */
function extraConfig(project: string, generated: GeneratedConfig, expected: ReadonlySet<string>): ConfigDrift[] {
  const root = readdirSync(project)
    .filter((entry) => generated.isConfig(entry) && !expected.has(entry.toLowerCase()))
    .map((path) => ({ path, problem: "no composed pack generates it" }));
  return [...root, ...nestedProblems(project, generated, expected)].sort(byPath);
}

const readIfPresent = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** The recorded fingerprint of bun.lock's clean resolution, or undefined. */
function readFingerprint(project: string): LockFingerprint | undefined {
  const text = readIfPresent(join(project, LOCK_FINGERPRINT));
  if (text === undefined) return undefined;
  try {
    return parseLockFingerprint(text);
  } catch {
    return undefined;
  }
}

/** Every way the project's config differs from what its packs generate. */
export function configDrift(project: string, harnessRoot = harnessRootOf()): ConfigDrift[] {
  const generated = generatedConfig(project, harnessRoot);
  const drift: ConfigDrift[] = [];
  for (const [name, content] of generated.files) {
    const actual = readIfPresent(join(project, name));
    if (actual === undefined) drift.push({ path: name, problem: "missing" });
    else if (actual !== content) drift.push({ path: name, problem: "differs from what the composed packs generate" });
  }
  const lock = readIfPresent(join(project, LOCKFILE));
  const fingerprint = readFingerprint(project);
  if (lock === undefined) drift.push({ path: LOCKFILE, problem: "missing" });
  else if (fingerprint === undefined) {
    drift.push({ path: LOCK_FINGERPRINT, problem: "missing or malformed: nothing records the clean resolution bun.lock must match" });
  } else {
    const problems = bunLockProblems(lock, generated.manifests, fingerprint);
    if (problems.length > 0) {
      drift.push({ path: LOCKFILE, problem: `does not resolve exactly the generated manifests and pins (${problems.slice(0, 3).join("; ")})` });
    }
  }
  const expected = new Set([...generated.files.keys(), LOCKFILE].map((name) => name.toLowerCase()));
  drift.push(...extraConfig(project, generated, expected));
  return drift.sort(byPath);
}

/**
 * The same check for the tools that spawn the test runner or type-checker
 * directly (run-tests.ts, typecheck.ts): one line naming the drifted files, or
 * undefined. It logs nothing — the gate or tool around it does.
 */
export function configDriftReason(cwd: string, harnessRoot = harnessRootOf()): string | undefined {
  if (!configIsGenerated(cwd)) return undefined;
  let drift: ConfigDrift[];
  try {
    drift = configDrift(cwd, harnessRoot);
  } catch (error) {
    return `config-drift: the generated project config cannot be computed (${error instanceof Error ? error.message : String(error)})`;
  }
  if (drift.length === 0) return undefined;
  return `config-drift: project config differs from what the composed packs generate (${drift.map((d) => d.path).join(", ")}); ` +
    `nothing was run — escalate to the user, who restores it with \`${SYNC_COMMAND}\``;
}

/**
 * The phase gates' shared pre-check. Undefined when the config matches (or
 * the project's config was not generated by its packs); otherwise a logged
 * BLOCK naming each file, routed to the orchestrator, because no role may
 * write project config.
 */
export function configDriftBlock(
  gate: string,
  cwd: string,
  harnessRoot = harnessRootOf(),
  options: { readonly tolerateDesignDrift?: boolean } = {},
): GateResult | undefined {
  if (!configIsGenerated(cwd)) return undefined;
  let drift: ConfigDrift[];
  try {
    drift = configDrift(cwd, harnessRoot);
    if (options.tolerateDesignDrift === true) {
      const roots = workspaceRootsOf(generatedConfig(cwd, harnessRoot));
      drift = drift.filter((d) => !isDesignDerivedDrift(d, roots));
    }
  } catch (error) {
    drift = [{ path: ".bounded/composed-packs.json", problem: `the generated config cannot be computed: ${error instanceof Error ? error.message : String(error)}` }];
  }
  if (drift.length === 0) return undefined;
  const summary = `project config differs from what the composed packs generate (${drift.map((d) => d.path).join(", ")})`;
  const result: GateResult = {
    code: 1,
    verdict: "block",
    summary,
    lines: [
      `${gate}: BLOCK — ${summary}`,
      ...drift.map((d) => `  ${d.path}: ${d.problem}`),
      "  No role may edit project config (ADR 2026-054): it is generated from the composed packs and the design.",
      `  Escalate to the user: \`${SYNC_COMMAND}\` restores it, and a dependency or setting the project needs belongs in a pack.`,
      `${gate}: route → orchestrator`,
    ],
    detail: { step: "config-drift", drift },
  };
  logGuardEvent(cwd, { guard: gate, verdict: "block", summary, detail: result.detail });
  return result;
}

export interface SyncResult {
  readonly code: 0 | 1;
  readonly lines: readonly string[];
  /** Files written or removed; 0 when the config already matched. */
  readonly changed?: number;
}

export interface SyncOptions {
  /** How `bun.lock` is produced when the old one no longer verifies. */
  readonly makeLockfile?: LockfileMaker;
}

/**
 * Rewrite the project's config from its composed packs and design: every
 * generated file, `bun.lock` (kept when it still verifies, otherwise derived
 * by `bun install --lockfile-only` in a scratch copy), and the removal of
 * every config file and misplaced dependency directory no pack generates.
 * Everything is computed before anything is written, so a refusal leaves the
 * project untouched. The design gate calls this too, when the design adds a
 * workspace (ADR 2026-061).
 */
export function syncProjectConfig(project: string, harnessRoot = harnessRootOf(), options: SyncOptions = {}): SyncResult {
  if (!configIsGenerated(project)) {
    return { code: 1, lines: ["sync-config: BLOCK — this project was not initialized by bounded init, so its config was never generated by its packs"] };
  }
  let generated: GeneratedConfig;
  let lock: FingerprintedLock;
  try {
    generated = generatedConfig(project, harnessRoot);
    const previous = { lock: readIfPresent(join(project, LOCKFILE)), fingerprint: readFingerprint(project) };
    lock = lockfileFor(generated.manifests, previous, options.makeLockfile ?? bunLockfileMaker);
  } catch (error) {
    return {
      code: 1,
      lines: [`sync-config: BLOCK — ${error instanceof Error ? error.message : String(error)}`, "  Nothing was written."],
    };
  }
  const writes = new Map(generated.files).set(LOCKFILE, lock.lock).set(LOCK_FINGERPRINT, serializeLockFingerprint(lock.fingerprint));
  const expected = new Set([...writes.keys()].map((name) => name.toLowerCase()));
  const removals = extraConfig(project, generated, expected);
  const lines: string[] = [];
  let changed = 0;
  for (const [name, content] of writes) {
    const path = join(project, name);
    if (readIfPresent(path) === content) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    changed += 1;
    lines.push(`sync-config: wrote ${name}`);
  }
  for (const { path } of removals) {
    rmSync(join(project, path), { recursive: true, force: true });
    changed += 1;
    lines.push(`sync-config: removed ${path} (no composed pack generates it)`);
  }
  lines.push(changed === 0
    ? "sync-config: OK — project config already matches the composed packs"
    : `sync-config: OK — ${changed} file${changed === 1 ? "" : "s"} restored`);
  logGuardEvent(project, { guard: "sync-config", verdict: "pass", summary: lines[lines.length - 1]!.replace(/^sync-config: /, ""), detail: { changed } });
  return { code: 0, lines, changed };
}

/** Runs one setup argv in the project; throws on a non-zero exit. */
export type SetupRun = (command: string, args: readonly string[], cwd: string) => void;

const execSetup: SetupRun = (command, args, cwd) => {
  execFileSync(command, [...args], { cwd, stdio: "inherit" });
};

/**
 * `bounded sync-config`: the sync, then the composed packs' own project setup
 * commands (ADR 2026-051) whenever the sync changed anything or a project
 * dependency tree is missing, so the user has one command. The commands are
 * the same pack data the lead's first setup runs: they install only from the
 * committed lockfile and never run the project's lifecycle scripts. This is
 * the one reinstall after the first run, and only the user reaches it.
 */
export function syncConfigCommand(
  project: string,
  harnessRoot = harnessRootOf(),
  run: SetupRun = execSetup,
  options: SyncOptions = {},
): SyncResult {
  const sync = syncProjectConfig(project, harnessRoot, options);
  if (sync.code !== 0) return sync;
  const root = resolve(project);
  let plan: SetupPlan;
  try {
    plan = setupPlan(root);
  } catch (error) {
    return { code: 1, lines: [...sync.lines, `sync-config: BLOCK — the composed setup commands cannot be read (${error instanceof Error ? error.message : String(error)})`] };
  }
  const harness = join(root, HARNESS_RELATIVE);
  const steps = plan.steps.filter((step) => step.cwd === root);
  const probes = plan.probes.filter((probe) => !probe.startsWith(harness + sep));
  if ((sync.changed ?? 0) === 0 && probes.every((probe) => existsSync(probe))) return sync;
  const lines = [...sync.lines];
  for (const step of steps) {
    const shown = [step.command, ...step.args].join(" ");
    try {
      run(step.command, step.args, root);
    } catch (error) {
      const summary = `reinstall failed: ${shown} (${error instanceof Error ? error.message : String(error)})`;
      logGuardEvent(root, { guard: "sync-config", verdict: "block", summary, detail: { step: step.label } });
      return { code: 1, lines: [...lines, `sync-config: BLOCK — ${summary}; the config is synced, the dependencies are not`] };
    }
    lines.push(`sync-config: ran ${shown}`);
  }
  const missing = probes.filter((probe) => !existsSync(probe));
  if (missing.length > 0) {
    const summary = `reinstall returned without ${missing.map((probe) => probe.slice(root.length + 1)).join(", ")}`;
    logGuardEvent(root, { guard: "sync-config", verdict: "block", summary, detail: {} });
    return { code: 1, lines: [...lines, `sync-config: BLOCK — ${summary}`] };
  }
  logGuardEvent(root, { guard: "sync-config", verdict: "pass", summary: "project dependencies reinstalled from the lockfile", detail: { steps: steps.length } });
  return { code: 0, lines, changed: sync.changed };
}

// --- the design's own config (ADR 2026-061) -----------------------------------------

/** The directories workspaces sit in (`contexts`, `apps`): the root
 *  manifest's `workspaces` globs, each `<root>/*`. */
function workspaceRootsOf(generated: GeneratedConfig): Set<string> {
  const globs = generated.pkg["workspaces"];
  const roots = new Set<string>();
  if (Array.isArray(globs)) {
    for (const glob of globs) if (typeof glob === "string" && /^[a-z0-9-]+\/\*$/.test(glob)) roots.add(glob.slice(0, -2));
  }
  return roots;
}

/**
 * Drift the design itself causes, which the design gate repairs rather than
 * refuses: a workspace manifest the design adds, changes or drops
 * (`<root>/<name>/package.json`, for a workspace root the composition
 * declares) and the lockfile that follows from the manifests. Contracts and
 * TNs decide these files (ADR 2026-061), and only the architect writes
 * those; no role can write a manifest. Every other drift is someone's edit,
 * and blocks.
 */
export function isDesignDerivedDrift(drift: ConfigDrift, workspaceRoots: ReadonlySet<string>): boolean {
  if (drift.path === LOCKFILE || drift.path === LOCK_FINGERPRINT) return true;
  const segments = drift.path.split("/");
  return segments.length === 3 && segments[2] === MANIFEST && workspaceRoots.has(segments[0]!);
}

/** A setup runner that captures output, for a gate: a failed command throws
 *  with the tail of what it printed. */
export const captureSetup: SetupRun = (command, args, cwd) => {
  try {
    execFileSync(command, [...args], { cwd, stdio: "pipe", encoding: "utf8", timeout: 600_000, env: { ...process.env, NO_COLOR: "1" } });
  } catch (error) {
    const out = error as { stdout?: unknown; stderr?: unknown; message?: string };
    const text = `${String(out.stdout ?? "")}\n${String(out.stderr ?? "")}`.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    throw new Error(text.slice(-4).join(" | ") || out.message || "the command failed");
  }
};

export interface DesignConfigSync {
  readonly code: 0 | 1;
  readonly lines: readonly string[];
  /** Workspace directories whose manifest was written (added or changed). */
  readonly workspaces: readonly string[];
}

/**
 * Bring the project's config in line with a design that adds, changes or
 * drops a workspace (ADR 2026-061): the manifests and lockfile are rewritten
 * (sync-config's own function), then the composed setup commands install
 * from the new lockfile, so the next step's type check sees every workspace
 * linked. Runs only when every drifted file is design-derived; any other
 * drift is left for the gate's own refusal. Producing a lockfile for a new
 * dependency needs the package registry or bun's cache, and installing it
 * needs the package; when either is unreachable this refuses and says so,
 * having written nothing but the verified config.
 */
export function syncDesignConfig(
  cwd: string,
  harnessRoot = harnessRootOf(),
  run: SetupRun = captureSetup,
  options: SyncOptions = {},
): DesignConfigSync {
  if (!configIsGenerated(cwd)) return { code: 0, lines: [], workspaces: [] };
  let drift: ConfigDrift[];
  let roots: Set<string>;
  try {
    drift = configDrift(cwd, harnessRoot);
    roots = workspaceRootsOf(generatedConfig(cwd, harnessRoot));
  } catch (error) {
    return { code: 1, lines: [`the design's workspaces cannot be derived: ${error instanceof Error ? error.message : String(error)}`], workspaces: [] };
  }
  const derived = drift.filter((d) => isDesignDerivedDrift(d, roots));
  if (derived.length === 0 || derived.length !== drift.length) return { code: 0, lines: [], workspaces: [] };
  const workspaces = derived.filter((d) => d.path.endsWith(`/${MANIFEST}`)).map((d) => d.path.slice(0, -MANIFEST.length - 1));
  const what = workspaces.length > 0 ? `workspace${workspaces.length === 1 ? "" : "s"} ${workspaces.join(", ")}` : "the lockfile";
  const result = syncConfigCommand(cwd, harnessRoot, run, options);
  if (result.code !== 0) {
    const reason = result.lines.filter((l) => /BLOCK/.test(l)).map((l) => l.replace(/^sync-config: BLOCK — /, "")).join("; ");
    return {
      code: 1,
      lines: [
        `the design changes ${what}, and its config could not be brought in line: ${reason}`,
        "  A new workspace's lockfile and install need the package registry (or bun's cache) reachable:",
        "  connect, then run the design gate again. Nothing the design owns was lost.",
      ],
      workspaces,
    };
  }
  // sync-config's own summary ("OK — n files restored") would read as a
  // second verdict inside the scaffold step's output: drop it.
  const lines = result.lines
    .map((l) => l.replace(/^sync-config: /, ""))
    .filter((l) => !/^OK — /.test(l));
  return { code: 0, lines: [`config follows the design (${what})`, ...lines], workspaces };
}
