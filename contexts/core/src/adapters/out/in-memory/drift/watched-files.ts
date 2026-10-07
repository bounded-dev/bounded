import { createHash } from "node:crypto";
import type { WatchedFiles, WatchedHashes } from "bounded/application";
import type { Result, WatchedPath } from "bounded/domain";

/** The first rule that watches `path`: one whose match finds it and whose except does not; -1 when none does. */
export function watchingRule(rules: readonly WatchedPath[], path: string): number {
  return rules.findIndex((rule) => new Bun.Glob(rule.match).match(path) && !(rule.except ?? []).some((except) => new Bun.Glob(except).match(path)));
}

const digest = (content: string): string => createHash("sha256").update(content).digest("hex");

/** Files in memory over a fixed version control: for tests and hosts without a disk. */
export class InMemoryWatchedFiles implements WatchedFiles {
  private readonly working: Map<string, string>;

  constructor(private readonly committed: Readonly<Record<string, string>>) {
    this.working = new Map(Object.entries(committed));
  }

  async hash(rules: readonly WatchedPath[]): Promise<Result<WatchedHashes>> {
    const out: Record<string, { hash: string; rule: number }> = {};
    for (const [path, content] of this.working) {
      const rule = path.startsWith(".bounded/") ? -1 : watchingRule(rules, path);
      if (rule >= 0) out[path] = { hash: digest(content), rule };
    }
    return { ok: true, value: out };
  }

  async restore(paths: readonly string[]): Promise<Result<void>> {
    for (const path of paths) {
      const content = this.committed[path];
      if (content === undefined) this.working.delete(path);
      else this.working.set(path, content);
    }
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
