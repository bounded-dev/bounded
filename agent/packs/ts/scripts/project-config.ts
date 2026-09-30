// Project configuration is generated from the composed packs, never written
// by a role (ADR 2026-054).
//
// In a project-local installation (`bounded init`), the package manifest, its
// lockfile, the compiler config and every other file the composed packs name
// as project config are a pure function of the composition: the package
// template, pins and scripts (project-package.ts) and each pack's
// `projectConfigFiles` reference copies. This module computes that function
// and compares the project against it.
//
// · Every gate and tool that runs the test runner, type-checker or bundler
//   (design, red, green, deliver, run-tests, typecheck, mutation-score, the
//   web render) calls `configDriftBlock` first, and the two spawning
//   primitives (runTests, typecheck) refuse through `configDriftReason`: a
//   changed, missing or extra config file is a BLOCK, whoever made it. Some
//   of these files are loaded as code (the test runner's config), so nothing
//   may run over config the packs did not produce. "Extra" covers the root
//   (`projectConfigNames`) and, below it, the files Node and the test
//   runner's transform read per directory (`projectNestedConfigNames`: a
//   nested package.json or tsconfig), and any nested dependency directory
//   (`projectDependencyDirs`), `.git` or `.bounded`, which the tools would
//   honour before the root's.
// · `sync-config` (the user's command, scripts/sync-config.ts) rewrites the
//   files from the same function, then reinstalls through the composed
//   packs' setup commands when anything changed.
//
// The lockfile is derived, not copied: it must hold exactly the closure of the
// generated pins. The expectation is taken from the project's own lockfile
// (so a project-local harness, which carries no full source lock, can still
// check it); sync falls back to the harness's source lock when the pins have
// moved past what the project's lockfile holds.
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
import { fileNameGlobs, fileNameMatcher, projectConfigSources, projectDependencyDirs } from "../../../src/pack-contrib.ts";
import { readProjectPacks } from "../../../src/project-composition.ts";
import { lockFor } from "../../../src/runtime-lock.ts";
import { HARNESS_RELATIVE, HOST_PACKAGE_DIRS, INSTALLATION_RELATIVE, setupPlan, type SetupPlan } from "../../../src/setup-state.ts";
import { packageFor, shippedFiles } from "./project-package.ts";

export const MANIFEST = "package.json";
export const LOCKFILE = "package-lock.json";
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

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

/** The directories the nested walk never enters at the ROOT: version control,
 *  harness state and the composed packs' dependency directories (whose own
 *  manifests are theirs). Below the root, any of them is drift: the stack's
 *  tools resolve a nested dependency directory or manifest before the root's,
 *  and git treats a nested repository as a boundary. */
const CORE_ROOT_SKIP = [".git", ".bounded"] as const;
/** Host package installs (pi's `.pi/npm`, `.pi/git`) hold the host's own
 *  dependency trees; no stack tool reads them, so the walk never enters them. */
const HOST_SKIP: ReadonlySet<string> = new Set(HOST_PACKAGE_DIRS);

/** Nested problems below the root: config files `isNested` names, and any
 *  directory `protectedDir` names. A protected directory is reported once and
 *  not entered. */
function nestedProblems(
  project: string,
  isNested: (name: string) => boolean,
  protectedDirs: ReadonlySet<string>,
): ConfigDrift[] {
  const out: ConfigDrift[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(project, rel), { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (HOST_SKIP.has(path)) continue;
      if (protectedDirs.has(entry.name.toLowerCase())) {
        out.push({ path, problem: "a dependency, version-control or harness directory below the project root, which the stack's tools would honour before the root's" });
      } else if (entry.isDirectory()) walk(path);
      else if (isNested(entry.name)) out.push({ path, problem: "no composed pack generates it" });
    }
  };
  for (const entry of readdirSync(project, { withFileTypes: true })) {
    if (entry.isDirectory() && !protectedDirs.has(entry.name.toLowerCase())) walk(entry.name);
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What the composed packs generate, file by file, except the lockfile. */
export interface GeneratedConfig {
  readonly pkg: ReturnType<typeof packageFor>;
  /** Project-relative path → exact bytes. */
  readonly files: ReadonlyMap<string, string>;
  /** Does a root entry name count as project config? */
  readonly isConfig: (entry: string) => boolean;
  /** Does a file name count as project config at any depth below the root? */
  readonly isNestedConfig: (name: string) => boolean;
  /** Directory names (lowercase) skipped at the root and drift below it:
   *  the core's `.git` and `.bounded`, and the packs' dependency directories. */
  readonly protectedDirs: ReadonlySet<string>;
}

export function generatedConfig(project: string, harnessRoot = harnessRootOf()): GeneratedConfig {
  const packsDir = join(harnessRoot, "packs");
  const packs = readProjectPacks(project);
  const pkg = packageFor(packs, packsDir);
  const files = new Map<string, string>([[MANIFEST, json(pkg)]]);
  for (const { pack, source, target } of projectConfigSources(packs, packsDir)) {
    if (target === MANIFEST || target === LOCKFILE) throw new Error(`Capability '${pack}' may not ship ${target} as a config file`);
    files.set(target, readFileSync(source, "utf8"));
  }
  for (const { path, source } of shippedFiles(packs, packsDir)) files.set(path, readFileSync(source, "utf8"));
  return {
    pkg,
    files,
    isConfig: fileNameMatcher(fileNameGlobs("projectConfigNames", packs, packsDir)),
    isNestedConfig: fileNameMatcher(fileNameGlobs("projectNestedConfigNames", packs, packsDir)),
    protectedDirs: new Set([...CORE_ROOT_SKIP, ...projectDependencyDirs(packs, packsDir)].map((name) => name.toLowerCase())),
  };
}

/** Config present that no composed pack generates: root files by
 *  `projectConfigNames`, nested files by `projectNestedConfigNames`, and any
 *  protected directory below the root. */
function extraConfig(project: string, generated: GeneratedConfig, expected: ReadonlySet<string>): ConfigDrift[] {
  const root = readdirSync(project)
    .filter((entry) => generated.isConfig(entry))
    .map((path) => ({ path, problem: "no composed pack generates it" }));
  return [...root, ...nestedProblems(project, generated.isNestedConfig, generated.protectedDirs)]
    .filter(({ path }) => !expected.has(path.toLowerCase()))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The lockfile the pins require, derived from `sourceRoot`'s lockfile; undefined when it cannot supply them. */
function lockFrom(pkg: GeneratedConfig["pkg"], sourceRoot: string): string | undefined {
  try {
    return json(lockFor(pkg, sourceRoot));
  } catch {
    return undefined;
  }
}

export interface ConfigDrift {
  readonly path: string;
  readonly problem: string;
}

/** Every way the project's config differs from what its packs generate. */
export function configDrift(project: string, harnessRoot = harnessRootOf()): ConfigDrift[] {
  const generated = generatedConfig(project, harnessRoot);
  const drift: ConfigDrift[] = [];
  const read = (name: string): string | undefined => {
    const path = join(project, name);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };
  for (const [name, content] of generated.files) {
    const actual = read(name);
    if (actual === undefined) drift.push({ path: name, problem: "missing" });
    else if (actual !== content) drift.push({ path: name, problem: "differs from what the composed packs generate" });
  }
  const lock = read(LOCKFILE);
  if (lock === undefined) drift.push({ path: LOCKFILE, problem: "missing" });
  else if (lockFrom(generated.pkg, project) !== lock) {
    drift.push({ path: LOCKFILE, problem: "does not hold exactly the dependencies the composed packs pin" });
  }
  const expected = new Set([...generated.files.keys(), LOCKFILE].map((name) => name.toLowerCase()));
  drift.push(...extraConfig(project, generated, expected));
  return drift;
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
      "  No role may edit project config (ADR 2026-054): it is generated from the composed packs' reference files and pins.",
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

/**
 * Rewrite the project's config from its composed packs: every generated file,
 * the lockfile derived for the generated pins, and the removal of any config
 * file no pack generates. Everything is computed before anything is written,
 * so a refusal leaves the project untouched.
 */
export function syncProjectConfig(project: string, harnessRoot = harnessRootOf()): SyncResult {
  if (!configIsGenerated(project)) {
    return { code: 1, lines: ["sync-config: BLOCK — this project was not initialized by bounded init, so its config was never generated by its packs"] };
  }
  let generated: GeneratedConfig;
  try {
    generated = generatedConfig(project, harnessRoot);
  } catch (error) {
    return { code: 1, lines: [`sync-config: BLOCK — ${error instanceof Error ? error.message : String(error)}`] };
  }
  const lock = lockFrom(generated.pkg, project) ?? lockFrom(generated.pkg, harnessRoot);
  if (lock === undefined) {
    return {
      code: 1,
      lines: [
        "sync-config: BLOCK — neither the project's lockfile nor this harness's source lock holds every pinned dependency version.",
        "  Nothing was written. Run the sync from a harness whose source lock carries the new pins.",
      ],
    };
  }
  const writes = new Map(generated.files).set(LOCKFILE, lock);
  const lines: string[] = [];
  let changed = 0;
  for (const [name, content] of writes) {
    const path = join(project, name);
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    changed += 1;
    lines.push(`sync-config: wrote ${name}`);
  }
  const expected = new Set([...writes.keys()].map((name) => name.toLowerCase()));
  for (const { path } of extraConfig(project, generated, expected)) {
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
export function syncConfigCommand(project: string, harnessRoot = harnessRootOf(), run: SetupRun = execSetup): SyncResult {
  const sync = syncProjectConfig(project, harnessRoot);
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
