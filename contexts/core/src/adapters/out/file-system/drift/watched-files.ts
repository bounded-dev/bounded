import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RestoreFrom, WatchedFiles, WatchedHashes } from "bounded/application";
import type { Result, WatchedPath } from "bounded/domain";
import { isInside, isOwnState, mayHold, ruleFields, watcher } from "../../shared/watching.ts";

const text = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
/** Enough for the watched files of a large commit in one read. */
const MAX_BUFFER = 1024 * 1024 * 1024;

/** A file mode with execute added wherever it can be read. */
const executableMode = (mode: number): number => (mode & 0o777) | ((mode & 0o444) >> 2);

/**
 * The project's files on disk, under git. Hashing takes the files git lists
 * (tracked, untracked and ignored; outside git, a walk of only the
 * directories a rule's fixed leading part can lead to), never inside
 * node_modules, .git or a linked directory; a link a rule matches is
 * recorded by where it points, never followed. Restoring writes one file's bytes and executable bit, from
 * a copy or from a commit, and leaves git's index alone. What a command
 * created is moved into a new directory under `quarantine`, never deleted.
 */
export class FileSystemWatchedFiles implements WatchedFiles {
  constructor(
    private readonly root: string,
    private readonly quarantineDir: string,
  ) {}

  async hash(rules: readonly WatchedPath[]): Promise<Result<WatchedHashes>> {
    try {
      const watching = watcher(rules);
      const enter = mayHold(rules);
      const out: Record<string, { hash: string; size: number; rule: number; rules?: readonly number[]; link?: true }> = {};
      /** A file or link, hashed when a rule watches it. */
      const take = (path: string, kind: "file" | "link"): void => {
        const by = watching(path);
        if (by.length === 0) return;
        if (kind === "link") {
          const target = Buffer.from(readlinkSync(join(this.root, path)));
          out[path] = { hash: sha256(Buffer.concat([Buffer.from("link\0"), target])), size: target.length, ...ruleFields(by), link: true };
        } else {
          const bytes = readFileSync(join(this.root, path));
          out[path] = { hash: sha256(bytes), size: bytes.length, ...ruleFields(by) };
        }
      };
      const walk = (dir: string): void => {
        for (const entry of readdirSync(join(this.root, dir), { withFileTypes: true })) {
          const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
          // A directory entry is never a link here: readdir does not follow them.
          if (entry.isDirectory()) {
            if (enter(path)) walk(path);
          } else if (entry.isFile()) take(path, "file");
          else if (entry.isSymbolicLink()) take(path, "link");
        }
      };
      if (rules.length === 0) return { ok: true, value: out };
      const listed = this.listed();
      if (!listed.ok) return listed;
      if (listed.value === null) walk("");
      for (const path of listed.value ?? []) {
        // An ignored directory git lists whole: walked only where a rule may reach.
        if (path.endsWith("/")) {
          const dir = path.slice(0, -1);
          if (enter(dir)) walk(dir);
          continue;
        }
        const found = lstatSync(join(this.root, path), { throwIfNoEntry: false });
        if (found?.isFile()) take(path, "file");
        else if (found?.isSymbolicLink()) take(path, "link");
      }
      return { ok: true, value: out };
    } catch (thrown) {
      return { ok: false, error: text(thrown) };
    }
  }

  /**
   * The project's files as git lists them: tracked and untracked files, then
   * ignored files and ignored directories (ending in '/') whole, so nothing
   * protected is missed for being ignored. Null when the project is not a git
   * repository (or git cannot run), so the files are walked instead.
   */
  private listed(): Result<readonly string[] | null> {
    const inside = this.git(["rev-parse", "--is-inside-work-tree"]);
    if (inside.error !== undefined || inside.status !== 0) return { ok: true, value: null };
    const paths: string[] = [];
    for (const args of [["ls-files", "-z", "-c", "-o", "--exclude-standard"], ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"]]) {
      const run = this.git(args);
      if (run.error !== undefined || run.status !== 0) return { ok: false, error: `git could not list the project's files: ${run.error?.message ?? run.stderr.toString().trim()}` };
      paths.push(...run.stdout.toString().split("\0").filter((path) => path !== "" && !isOwnState(path.replace(/\/$/, ""))));
    }
    return { ok: true, value: [...new Set(paths)] };
  }

  rulesWatching(rules: readonly WatchedPath[], path: string): readonly number[] {
    return watcher(rules)(path);
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
    const blobs: { path: string; oid: string; by: readonly number[] }[] = [];
    for (const entry of listed.stdout.toString().split("\0")) {
      const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
      // Regular files only (a link is mode 120000), as the walk sees them.
      if (match === null || match[1] === "120000") continue;
      const [, , oid = "", path = ""] = match;
      const by = watching(path);
      if (by.length > 0) blobs.push({ path, oid, by });
    }
    if (blobs.length === 0) return { ok: true, value: {} };
    const read = this.git(["cat-file", "--batch"], `${blobs.map((blob) => blob.oid).join("\n")}\n`);
    if (read.error !== undefined || read.status !== 0) return { ok: false, error: `git could not read commit ${commit}: ${read.error?.message ?? read.stderr.toString().trim()}` };
    const out: Record<string, { hash: string; size: number; rule: number; rules?: readonly number[] }> = {};
    let at = 0;
    for (const blob of blobs) {
      const newline = read.stdout.indexOf(0x0a, at);
      const size = Number(read.stdout.subarray(at, newline).toString().split(" ")[2]);
      const bytes = read.stdout.subarray(newline + 1, newline + 1 + size);
      out[blob.path] = { hash: sha256(bytes), size, ...ruleFields(blob.by) };
      at = newline + 1 + size + 1;
    }
    return { ok: true, value: out };
  }

  async copy(path: string): Promise<Result<{ hash: string; size: number; content: string; executable: boolean }>> {
    try {
      const found = isInside(path) ? lstatSync(join(this.root, path)) : undefined;
      if (found === undefined || !found.isFile()) return { ok: false, error: `${path} is not a file inside the project` };
      const bytes = readFileSync(join(this.root, path));
      return { ok: true, value: { hash: sha256(bytes), size: bytes.length, content: bytes.toString("base64"), executable: (found.mode & 0o100) !== 0 } };
    } catch (thrown) {
      return { ok: false, error: `${path} could not be copied: ${text(thrown)}` };
    }
  }

  async restore(path: string, from: RestoreFrom): Promise<Result<void>> {
    if (!isInside(path)) return { ok: false, error: `${path} is not inside the project` };
    let bytes: Buffer;
    let executable: boolean;
    if (from.from === "copy") [bytes, executable] = [Buffer.from(from.content, "base64"), from.executable];
    else {
      const failed = (run: ReturnType<FileSystemWatchedFiles["git"]>) => `${path} could not be restored from commit ${from.commit}: ${run.error?.message ?? run.stderr.toString().trim()}`;
      const shown = this.git(["cat-file", "blob", `${from.commit}:./${path}`]);
      if (shown.error !== undefined || shown.status !== 0) return { ok: false, error: failed(shown) };
      const listed = this.git(["ls-tree", from.commit, "--", path]);
      if (listed.error !== undefined || listed.status !== 0) return { ok: false, error: failed(listed) };
      [bytes, executable] = [shown.stdout, listed.stdout.toString().startsWith("100755")];
    }
    const file = join(this.root, path);
    try {
      // The command left something there: it goes first, so a link is never written through.
      rmSync(file, { force: true });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      if (executable) chmodSync(file, executableMode(statSync(file).mode));
      return { ok: true, value: undefined };
    } catch (thrown) {
      return { ok: false, error: `${path} could not be restored: ${text(thrown)}` };
    }
  }

  async quarantine(paths: readonly string[]): Promise<Result<string>> {
    const outside = paths.find((path) => !isInside(path));
    if (outside !== undefined) return { ok: false, error: `${outside} is not inside the project` };
    const location = join(this.quarantineDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
    try {
      mkdirSync(location, { recursive: true, mode: 0o700 });
      chmodSync(this.quarantineDir, 0o700);
      chmodSync(location, 0o700);
      for (const path of paths) {
        const [from, to] = [join(this.root, path), join(location, path)];
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        move(from, to);
        if (!lstatSync(to).isSymbolicLink()) chmodSync(to, 0o600);
      }
      return { ok: true, value: location };
    } catch (thrown) {
      return { ok: false, error: `moving files to ${location} failed: ${text(thrown)}` };
    }
  }

  private git(args: readonly string[], input?: string) {
    return spawnSync("git", args, { cwd: this.root, maxBuffer: MAX_BUFFER, ...(input === undefined ? {} : { input }) });
  }
}

/** Moves a file or link, copying it across file systems when it cannot be renamed. */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (thrown) {
    if ((thrown as { code?: unknown }).code !== "EXDEV") throw thrown;
    if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
    rmSync(from);
  }
}
