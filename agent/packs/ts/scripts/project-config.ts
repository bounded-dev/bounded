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
//   (`bunLockProblems`, no network).
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
  LOCKFILE,
  lockfileFor,
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
  if (lock === undefined) drift.push({ path: LOCKFILE, problem: "missing" });
  else {
    const problems = bunLockProblems(lock, generated.manifests);
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
export function configDriftBlock(gate: string, cwd: string, harnessRoot = harnessRootOf()): GateResult | undefined {
  if (!configIsGenerated(cwd)) return undefined;
  let drift: ConfigDrift[];
  try {
    drift = configDrift(cwd, harnessRoot);
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
  let lock: string;
  try {
    generated = generatedConfig(project, harnessRoot);
    lock = lockfileFor(generated.manifests, readIfPresent(join(project, LOCKFILE)), options.makeLockfile ?? bunLockfileMaker);
  } catch (error) {
    return {
      code: 1,
      lines: [`sync-config: BLOCK — ${error instanceof Error ? error.message : String(error)}`, "  Nothing was written."],
    };
  }
  const writes = new Map(generated.files).set(LOCKFILE, lock);
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
