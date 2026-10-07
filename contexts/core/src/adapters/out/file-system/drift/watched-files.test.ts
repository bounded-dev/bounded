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
    const files = new FileSystemWatchedFiles(root);
    expect((await files.restore("a.ts", { from: "commit", commit: "HEAD" })).ok).toBe(false);
    expect(await files.head()).toEqual({ ok: true, value: null });
  });

  test("restoring from a commit leaves the index alone: staged work stays staged", async () => {
    const root = repository({ "a.ts": "a", "b.ts": "b" });
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    writeFileSync(join(root, "b.ts"), "staged");
    git("add", "b.ts");
    writeFileSync(join(root, "a.ts"), "tampered");
    const files = new FileSystemWatchedFiles(root);
    const head = await files.head();
    if (!head.ok || head.value === null) throw new Error("expected a commit");
    expect(await files.restore("a.ts", { from: "commit", commit: head.value })).toEqual({ ok: true, value: undefined });
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("a");
    expect(git("diff", "--cached", "--name-only").stdout.trim()).toBe("b.ts");
  });

  test("runs under node, as pi runs it: no Bun API", () => {
    const root = repository({ "generated/a.ts": "a", "src/b.ts": "b" });
    const script = join(mkdtempSync(join(tmpdir(), "node-drift-")), "run.mjs");
    writeFileSync(
      script,
      `import { FileSystemWatchedFiles } from ${JSON.stringify(join(import.meta.dir, "watched-files.ts"))};
const files = new FileSystemWatchedFiles(${JSON.stringify(root)});
const rules = [{ match: "generated/**", except: [], why: "w", redirect: "r" }];
const head = await files.head();
const out = { hash: await files.hash(rules), committed: await files.committed(rules, head.value) };
process.stdout.write(JSON.stringify(out));
`,
    );
    // pi loads extensions through jiti, which compiles TypeScript fully; node needs transform-types for that.
    const run = spawnSync("node", ["--experimental-transform-types", "--no-warnings", script], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    const out = JSON.parse(run.stdout) as { hash: { ok: boolean; value: object }; committed: { ok: boolean; value: object } };
    expect(Object.keys(out.hash.value)).toEqual(["generated/a.ts"]);
    expect(out.committed).toEqual(out.hash);
  });
});
