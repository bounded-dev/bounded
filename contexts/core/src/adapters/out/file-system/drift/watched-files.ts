import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RestoreFrom, WatchedFiles, WatchedHashes } from "bounded/application";
import type { Result, WatchedPath } from "bounded/domain";
import { isInside, mayHold, watcher } from "../../shared/watching.ts";

const text = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
/** Enough for the watched files of a large commit in one read. */
const MAX_BUFFER = 1024 * 1024 * 1024;

/**
 * The project's files on disk, under git. Hashing walks only the directories
 * a rule's fixed leading part can lead to, and sees regular files only (a
 * link is never followed). Restoring writes one file's bytes, from a copy or
 * from a commit, and leaves git's index alone.
 */
export class FileSystemWatchedFiles implements WatchedFiles {
  constructor(private readonly root: string) {}

  async hash(rules: readonly WatchedPath[]): Promise<Result<WatchedHashes>> {
    try {
      const watching = watcher(rules);
      const enter = mayHold(rules);
      const out: Record<string, { hash: string; size: number; rule: number }> = {};
      const walk = (dir: string): void => {
        for (const entry of readdirSync(join(this.root, dir), { withFileTypes: true })) {
          const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
          if (entry.isDirectory()) {
            if (enter(path)) walk(path);
          } else if (entry.isFile()) {
            const rule = watching(path);
            if (rule < 0) continue;
            const bytes = readFileSync(join(this.root, path));
            out[path] = { hash: sha256(bytes), size: bytes.length, rule };
          }
        }
      };
      if (rules.length > 0) walk("");
      return { ok: true, value: out };
    } catch (thrown) {
      return { ok: false, error: text(thrown) };
    }
  }

  async head(): Promise<Result<string | null>> {
    const head = this.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    // No git, no repository, or no commit yet: there is no commit to compare with.
    if (head.error !== undefined || head.status !== 0) return { ok: true, value: null };
    return { ok: true, value: head.stdout.toString().trim() };
  }

  async committed(rules: readonly WatchedPath[], commit: string): Promise<Result<WatchedHashes>> {
    const watching = watcher(rules);
    // Paths relative to the project, which may be a directory inside the repository.
    const listed = this.git(["ls-tree", "-r", "-z", commit]);
    if (listed.error !== undefined || listed.status !== 0) return { ok: false, error: `git could not list commit ${commit}: ${listed.error?.message ?? listed.stderr.toString().trim()}` };
    const blobs: { path: string; oid: string; rule: number }[] = [];
    for (const entry of listed.stdout.toString().split("\0")) {
      const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
      // Regular files only (a link is mode 120000), as the walk sees them.
      if (match === null || match[1] === "120000") continue;
      const [, , oid = "", path = ""] = match;
      const rule = watching(path);
      if (rule >= 0) blobs.push({ path, oid, rule });
    }
    if (blobs.length === 0) return { ok: true, value: {} };
    const read = this.git(["cat-file", "--batch"], `${blobs.map((blob) => blob.oid).join("\n")}\n`);
    if (read.error !== undefined || read.status !== 0) return { ok: false, error: `git could not read commit ${commit}: ${read.error?.message ?? read.stderr.toString().trim()}` };
    const out: Record<string, { hash: string; size: number; rule: number }> = {};
    let at = 0;
    for (const blob of blobs) {
      const newline = read.stdout.indexOf(0x0a, at);
      const size = Number(read.stdout.subarray(at, newline).toString().split(" ")[2]);
      const bytes = read.stdout.subarray(newline + 1, newline + 1 + size);
      out[blob.path] = { hash: sha256(bytes), size, rule: blob.rule };
      at = newline + 1 + size + 1;
    }
    return { ok: true, value: out };
  }

  async copy(path: string): Promise<Result<{ hash: string; size: number; content: string }>> {
    try {
      if (!isInside(path) || !lstatSync(join(this.root, path)).isFile()) return { ok: false, error: `${path} is not a file inside the project` };
      const bytes = readFileSync(join(this.root, path));
      return { ok: true, value: { hash: sha256(bytes), size: bytes.length, content: bytes.toString("base64") } };
    } catch (thrown) {
      return { ok: false, error: `${path} could not be copied: ${text(thrown)}` };
    }
  }

  async restore(path: string, from: RestoreFrom): Promise<Result<void>> {
    if (!isInside(path)) return { ok: false, error: `${path} is not inside the project` };
    let bytes: Buffer | undefined;
    if (from.from === "copy") bytes = Buffer.from(from.content, "base64");
    else if (from.from === "commit") {
      const shown = this.git(["cat-file", "blob", `${from.commit}:./${path}`]);
      if (shown.error !== undefined || shown.status !== 0) return { ok: false, error: `${path} could not be restored from commit ${from.commit}: ${shown.error?.message ?? shown.stderr.toString().trim()}` };
      bytes = shown.stdout;
    }
    const file = join(this.root, path);
    try {
      // Whatever is there now goes first, so a link the command left is never written through.
      rmSync(file, { force: true });
      if (bytes !== undefined) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      }
      return { ok: true, value: undefined };
    } catch (thrown) {
      return { ok: false, error: `${path} could not be restored: ${text(thrown)}` };
    }
  }

  private git(args: readonly string[], input?: string) {
    return spawnSync("git", args, { cwd: this.root, maxBuffer: MAX_BUFFER, ...(input === undefined ? {} : { input }) });
  }
}
