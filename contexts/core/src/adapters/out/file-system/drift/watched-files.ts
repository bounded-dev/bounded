import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WatchedFiles, WatchedHashes } from "bounded/application";
import type { Result, WatchedPath } from "bounded/domain";

function text(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * The project's files on disk, under git: hashing the files the rules watch
 * (never inside .git), and putting files back from the last commit, removing
 * those it never held.
 */
export class FileSystemWatchedFiles implements WatchedFiles {
  constructor(private readonly root: string) {}

  async hash(rules: readonly WatchedPath[]): Promise<Result<WatchedHashes>> {
    try {
      const out: Record<string, { hash: string; rule: number }> = {};
      for (const [index, rule] of rules.entries()) {
        const excepts = (rule.except ?? []).map((except) => new Bun.Glob(except));
        for await (const path of new Bun.Glob(rule.match).scan({ cwd: this.root, dot: true, onlyFiles: true, followSymlinks: false })) {
          const normal = path.split("\\").join("/");
          if (normal === ".git" || normal.startsWith(".git/") || out[normal] !== undefined || excepts.some((except) => except.match(normal))) continue;
          out[normal] = { hash: createHash("sha256").update(readFileSync(join(this.root, normal))).digest("hex"), rule: index };
        }
      }
      return { ok: true, value: out };
    } catch (thrown) {
      return { ok: false, error: text(thrown) };
    }
  }

  async restore(paths: readonly string[]): Promise<Result<void>> {
    const git = (...args: string[]) => spawnSync("git", args, { cwd: this.root, encoding: "utf8" });
    for (const path of paths) {
      if (path.startsWith("/") || path.split("/").includes("..")) return { ok: false, error: `${path} is not inside the project` };
      const tracked = git("cat-file", "-e", `HEAD:${path}`);
      if (tracked.error !== undefined) return { ok: false, error: `git could not be run: ${tracked.error.message}` };
      if (tracked.status === 0) {
        const restored = git("checkout", "HEAD", "--", path);
        if (restored.status !== 0) return { ok: false, error: `${path} could not be restored from version control: ${restored.stderr.trim()}` };
        continue;
      }
      const repository = git("rev-parse", "--is-inside-work-tree");
      if (repository.status !== 0) return { ok: false, error: `${path} could not be restored: the project is not a git repository with a commit` };
      try {
        if (existsSync(join(this.root, path))) rmSync(join(this.root, path));
      } catch (thrown) {
        return { ok: false, error: `${path} could not be removed: ${text(thrown)}` };
      }
    }
    return { ok: true, value: undefined };
  }
}
