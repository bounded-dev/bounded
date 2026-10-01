// The design gate's scaffold step on the hexagonal monorepo (ADRs 2026-060,
// 2026-061): the composed emitters, run over the design, write everything
// mechanical into the live tree, and the project's config follows the
// design's workspaces.
//
//   generated   written whenever it differs: no role may write it (ADR
//               2026-058), so the emitter's bytes are the only right ones.
//   skeleton    written only where no file exists; once written it is the
//               builder's, and a re-run never overwrites real work.
//
// A generated file an earlier run wrote and the design no longer produces (a
// removed feature's command file) is deleted: the set of generated files is a
// function of the design, and a step that only adds makes that false the
// moment a contract goes. The record of what was written lives in
// `.bounded/emitted.json`, harness state no role can write, so the prune
// removes only what this step itself put there.
//
// Then the config: when the design adds, changes or drops a workspace, the
// manifests and lockfile are regenerated and the project reinstalled from
// them (project-config.ts `syncDesignConfig`), so the type check that follows
// sees every workspace linked. Everything is computed before anything is
// written: a design an emitter refuses writes nothing.
//
// The step logs "scaffold" guard events, which the phase gate reads to order
// the design phase.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logGuardEvent } from "../../../src/guard-log.ts";
import { generatedFileGlobs } from "../../../src/pack-contrib.ts";
import { harnessRootOf, syncDesignConfig } from "./project-config.ts";
import { emitProject, projectFactsOf, type ProjectFile } from "./project-emitters.ts";
import type { SetupRun } from "./project-config.ts";
import type { LockfileMaker } from "./project-package.ts";

/** Where the scaffold step records the generated files it wrote. */
export const EMITTED_RECORD = ".bounded/emitted.json";

export interface ScaffoldOptions {
  readonly harnessRoot?: string;
  /** How setup commands run after a workspace change (tests inject one). */
  readonly setup?: SetupRun;
  /** How bun.lock is produced after a workspace change (tests inject one). */
  readonly makeLockfile?: LockfileMaker;
}

function readRecord(cwd: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, EMITTED_RECORD), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string" && !p.split("/").includes("..")) : [];
  } catch {
    return [];
  }
}

function removeEmptyParents(cwd: string, rel: string): void {
  let dir = dirname(rel);
  while (dir !== "." && dir !== "") {
    const abs = join(cwd, dir);
    if (!existsSync(abs) || readdirSync(abs).length > 0) return;
    rmdirSync(abs);
    dir = dirname(dir);
  }
}

/** Write what the emitters produced into the live tree. Pure over `files`
 *  except for the disk; returns one line per change. */
export function writeEmittedFiles(cwd: string, files: readonly ProjectFile[]): { lines: string[]; written: number; kept: number } {
  const lines: string[] = [];
  let written = 0;
  let kept = 0;
  for (const file of files) {
    const abs = join(cwd, file.path);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    if (file.mode === "skeleton" && current !== undefined) {
      kept += 1;
      continue;
    }
    if (current === file.content) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content);
    written += 1;
    lines.push(`scaffold: wrote ${file.path} (${file.mode}, ${file.emitter})`);
  }
  return { lines, written, kept };
}

/**
 * Run the scaffold step. Exit 0 scaffolded · 1 the design cannot be emitted,
 * or its config cannot follow it · 2 there is no design to scaffold.
 */
export function runScaffold(cwd: string, options: ScaffoldOptions = {}): { code: number; lines: readonly string[] } {
  const harnessRoot = options.harnessRoot ?? harnessRootOf();
  const block = (summary: string, extra: readonly string[] = []): { code: number; lines: readonly string[] } => {
    logGuardEvent(cwd, { guard: "scaffold", verdict: "block", summary });
    return { code: 1, lines: [`scaffold: BLOCK — ${summary}`, ...extra] };
  };

  let files: ProjectFile[];
  try {
    const facts = projectFactsOf(cwd, "design", join(harnessRoot, "packs"));
    if (facts.workspaces.every((w) => w.contracts.length === 0)) {
      const summary = "no contract files under any source root — nothing to scaffold";
      logGuardEvent(cwd, { guard: "scaffold", verdict: "error", summary });
      return { code: 2, lines: [`scaffold: ${summary}`] };
    }
    files = emitProject(facts, generatedFileGlobs(cwd, join(harnessRoot, "packs")));
  } catch (error) {
    return block(error instanceof Error ? error.message : String(error));
  }

  const { lines, written, kept } = writeEmittedFiles(cwd, files);

  // The prune: generated files an earlier run wrote that the design no longer produces.
  const now = new Set(files.filter((f) => f.mode === "generated").map((f) => f.path));
  // Anything still emitted, in either mode, is never pruned.
  const emitted = new Set(files.map((f) => f.path));
  const pruned: string[] = [];
  for (const rel of readRecord(cwd)) {
    if (emitted.has(rel) || !existsSync(join(cwd, rel))) continue;
    rmSync(join(cwd, rel));
    removeEmptyParents(cwd, rel);
    pruned.push(rel);
    lines.push(`scaffold: pruned ${rel} — the design no longer produces it`);
  }
  mkdirSync(join(cwd, ".bounded"), { recursive: true });
  writeFileSync(join(cwd, EMITTED_RECORD), JSON.stringify([...now].sort(), null, 2) + "\n");

  const config = syncDesignConfig(cwd, harnessRoot, options.setup, options.makeLockfile === undefined ? {} : { makeLockfile: options.makeLockfile });
  if (config.code !== 0) return block(config.lines[0] ?? "the project config could not follow the design", [...lines, ...config.lines.slice(1)]);
  lines.push(...config.lines.map((l) => `scaffold: ${l}`));

  const summary = `${files.length} emitted file${files.length === 1 ? "" : "s"}: ${written} written, ${kept} skeleton${kept === 1 ? "" : "s"} kept` +
    (pruned.length > 0 ? `, ${pruned.length} pruned` : "") +
    (config.workspaces.length > 0 ? `; workspaces synced: ${config.workspaces.join(", ")}` : "");
  logGuardEvent(cwd, {
    guard: "scaffold",
    verdict: "pass",
    summary,
    detail: { emitted: files.length, written, kept, pruned, workspaces: config.workspaces },
  });
  lines.push(`scaffold: OK — ${summary}`);
  return { code: 0, lines };
}

/**
 * Project paths of every skeleton still exactly as its emitter writes it: no
 * builder has touched it, so a type error in it is the design's own defect
 * wearing the builder's path. Empty when the design cannot be emitted.
 */
export function untouchedSkeletons(cwd: string, harnessRoot = harnessRootOf()): Set<string> {
  try {
    const facts = projectFactsOf(cwd, "design", join(harnessRoot, "packs"));
    const files = emitProject(facts, generatedFileGlobs(cwd, join(harnessRoot, "packs")));
    return new Set(files
      .filter((f) => f.mode === "skeleton")
      .filter((f) => existsSync(join(cwd, f.path)) && readFileSync(join(cwd, f.path), "utf8") === f.content)
      .map((f) => f.path));
  } catch {
    return new Set();
  }
}
