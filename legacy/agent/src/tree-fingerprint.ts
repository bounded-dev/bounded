// The project's tree as one hash, without the harness's own state (ADR
// LEG-2026-073). A long gate's run is judged against the tree it ran on: its
// worker records this before and after the run, and a later call collects the
// result only over the tree the run left.
//
// In a git work tree it is the tree `git add -A` would write, built in a
// scratch index so the real one is never touched, with `.bounded/` left out
// (delivery-snapshot.ts's evidence, without the harness's state). Elsewhere it
// is a content hash of every file except `.git/`, `.bounded/` and the composed
// packs' dependency directories (`projectDependencyDirs`). The core names no
// technology: those directory names are pack data.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDependencyDirs } from "./pack-contrib.ts";
import { readProjectPacks } from "./project-composition.ts";

const HARNESS_STATE = ".bounded";

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): { ok: boolean; out: string } {
  const run = spawnSync("git", [...args], { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: run.status === 0, out: (run.stdout ?? "").trim() };
}

/** The tree git would commit for `cwd`, `.bounded/` excluded; undefined
 *  outside a git work tree. */
function gitTree(cwd: string): string | undefined {
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).out !== "true") return undefined;
  const scratch = mkdtempSync(join(tmpdir(), "bounded-fingerprint-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    if (!git(cwd, ["read-tree", "HEAD"], env).ok && !git(cwd, ["read-tree", "--empty"], env).ok) return undefined;
    if (!git(cwd, ["add", "-A", "--", ".", `:(exclude)${HARNESS_STATE}`], env).ok) return undefined;
    const tree = git(cwd, ["write-tree"], env);
    return tree.ok ? `git:${tree.out}` : undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The composed dependency directory names; none when the composition cannot be read. */
function dependencyDirs(cwd: string, packsDir?: string): ReadonlySet<string> {
  try {
    return new Set(projectDependencyDirs(readProjectPacks(cwd), packsDir));
  } catch {
    return new Set();
  }
}

/** Every file's path and content, in a stable order. */
function contentHash(cwd: string, skip: ReadonlySet<string>): string {
  const hash = createHash("sha256");
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (rel === "" && (name === ".git" || name === HARNESS_STATE)) continue;
      if (skip.has(name)) continue;
      const path = join(dir, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path, relPath);
      else if (stat.isSymbolicLink()) hash.update(`link\0${relPath}\0${readlinkSync(path)}\0`);
      else if (stat.isFile()) {
        hash.update(`file\0${relPath}\0`);
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  walk(cwd, "");
  return `files:${hash.digest("hex")}`;
}

/** The project's tree, as one comparable string. */
export function treeFingerprint(cwd: string, packsDir?: string): string {
  return gitTree(cwd) ?? contentHash(cwd, dependencyDirs(cwd, packsDir));
}
