import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WatchedPath } from "bounded/domain";
import { watchedFilesConformance } from "../../../../application/drift/watch-shell/watch-shell.watched-files.test-support.ts";
import { FileSystemWatchedFiles } from "./watched-files.ts";

/** A git repository holding `committed` in its HEAD. */
function repository(committed: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "watched-files-"));
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: root });
  git("init", "--quiet");
  for (const [path, content] of Object.entries(committed)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  return root;
}

watchedFilesConformance("FileSystemWatchedFiles", async (committed) => {
  const root = repository(committed);
  return {
    files: new FileSystemWatchedFiles(root),
    write: async (path, content) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    },
    remove: async (path) => rmSync(join(root, path)),
    read: async (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined),
  };
});

describe("FileSystemWatchedFiles", () => {
  const rule = (match: string) => {
    const parsed = WatchedPath.parse({ match, why: "w", redirect: "r" });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };

  test("never looks inside .git", async () => {
    const root = repository({ "a.ts": "a" });
    const hashed = await new FileSystemWatchedFiles(root).hash([rule("**")]);
    expect(hashed.ok && Object.keys(hashed.value).every((path) => !path.startsWith(".git/"))).toBe(true);
  });

  test("never looks inside .bounded, where bounded keeps its own state", async () => {
    const root = repository({ "a.ts": "a" });
    mkdirSync(join(root, ".bounded"));
    writeFileSync(join(root, ".bounded", "guard-log.jsonl"), "{}\n");
    const hashed = await new FileSystemWatchedFiles(root).hash([rule("**")]);
    expect(hashed.ok && Object.keys(hashed.value).every((path) => !path.startsWith(".bounded/"))).toBe(true);
    expect(hashed.ok && Object.keys(hashed.value)).toContain("a.ts");
  });

  test("restoring outside a git repository fails, saying why", async () => {
    const root = mkdtempSync(join(tmpdir(), "watched-files-"));
    writeFileSync(join(root, "a.ts"), "a");
    const restored = await new FileSystemWatchedFiles(root).restore(["a.ts"]);
    expect(restored.ok).toBe(false);
  });
});
