import { createHash } from "node:crypto";
import type { RestoreFrom, WatchedFiles, WatchedHashes } from "bounded/application";
import type { Result, WatchedPath } from "bounded/domain";
import { isInside, watcher } from "../../shared/watching.ts";

/** The commit an in-memory project is checked out from. */
const COMMIT = "memory";
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Files in memory over a fixed version control: for tests and hosts without a disk. */
export class InMemoryWatchedFiles implements WatchedFiles {
  private readonly working: Map<string, string>;

  constructor(private readonly committedFiles: Readonly<Record<string, string>>) {
    this.working = new Map(Object.entries(committedFiles));
  }

  async hash(rules: readonly WatchedPath[]): Promise<Result<WatchedHashes>> {
    return { ok: true, value: hashes(this.working, rules) };
  }

  async head(): Promise<Result<string | null>> {
    return { ok: true, value: COMMIT };
  }

  async committed(rules: readonly WatchedPath[], commit: string): Promise<Result<WatchedHashes>> {
    if (commit !== COMMIT) return { ok: false, error: `there is no commit ${commit}` };
    return { ok: true, value: hashes(Object.entries(this.committedFiles), rules) };
  }

  async copy(path: string): Promise<Result<{ hash: string; size: number; content: string }>> {
    const content = this.working.get(path);
    if (content === undefined) return { ok: false, error: `${path} does not exist` };
    const bytes = Buffer.from(content);
    return { ok: true, value: { hash: sha256(bytes), size: bytes.length, content: bytes.toString("base64") } };
  }

  async restore(path: string, from: RestoreFrom): Promise<Result<void>> {
    if (!isInside(path)) return { ok: false, error: `${path} is not inside the project` };
    if (from.from === "commit" && from.commit !== COMMIT) return { ok: false, error: `there is no commit ${from.commit}` };
    const content = from.from === "copy" ? Buffer.from(from.content, "base64").toString() : from.from === "commit" ? this.committedFiles[path] : undefined;
    if (content === undefined) this.working.delete(path);
    else this.working.set(path, content);
    return { ok: true, value: undefined };
  }

  write(path: string, content: string): void {
    this.working.set(path, content);
  }

  remove(path: string): void {
    this.working.delete(path);
  }

  read(path: string): string | undefined {
    return this.working.get(path);
  }
}

function hashes(files: Iterable<[string, string]>, rules: readonly WatchedPath[]): WatchedHashes {
  const watching = watcher(rules);
  const out: Record<string, { hash: string; size: number; rule: number }> = {};
  for (const [path, content] of files) {
    const rule = watching(path);
    const bytes = Buffer.from(content);
    if (rule >= 0) out[path] = { hash: sha256(bytes), size: bytes.length, rule };
  }
  return out;
}
