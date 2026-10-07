import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

/** The adapter over `root`, moving files aside into a fresh quarantine directory. */
const filesAt = (root: string): FileSystemWatchedFiles => new FileSystemWatchedFiles(root, join(mkdtempSync(join(tmpdir(), "quarantine-")), "quarantine"));

watchedFilesConformance("FileSystemWatchedFiles", async (committed) => {
  const root = repository(committed);
  return {
    files: filesAt(root),
    write: async (path, content) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    },
    remove: async (path) => rmSync(join(root, path)),
    read: async (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined),
    readQuarantined: async (location, path) => (existsSync(join(location, path)) ? readFileSync(join(location, path), "utf8") : undefined),
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
    const hashed = await filesAt(root).hash([rule("**")]);
    expect(hashed.ok && Object.keys(hashed.value).every((path) => !path.startsWith(".git/"))).toBe(true);
  });

  test("never looks inside .bounded, where bounded keeps its own state", async () => {
    const root = repository({ "a.ts": "a" });
    mkdirSync(join(root, ".bounded"));
    writeFileSync(join(root, ".bounded", "guard-log.jsonl"), "{}\n");
    const hashed = await filesAt(root).hash([rule("**")]);
    expect(hashed.ok && Object.keys(hashed.value).every((path) => !path.startsWith(".bounded/"))).toBe(true);
    expect(hashed.ok && Object.keys(hashed.value)).toContain("a.ts");
  });

  test("restoring outside a git repository fails, saying why", async () => {
    const root = mkdtempSync(join(tmpdir(), "watched-files-"));
    writeFileSync(join(root, "a.ts"), "a");
    const files = filesAt(root);
    expect((await files.restore("a.ts", { from: "commit", commit: "HEAD" })).ok).toBe(false);
    expect(await files.head()).toEqual({ ok: true, value: null });
  });

  test("restoring from a commit leaves the index alone: staged work stays staged", async () => {
    const root = repository({ "a.ts": "a", "b.ts": "b" });
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    writeFileSync(join(root, "b.ts"), "staged");
    git("add", "b.ts");
    writeFileSync(join(root, "a.ts"), "tampered");
    const files = filesAt(root);
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
const files = new FileSystemWatchedFiles(${JSON.stringify(root)}, ${JSON.stringify(join(root, "..", "quarantine"))});
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

  test("moves files aside into a new directory of its own, owner-only, keeping their paths", async () => {
    const root = repository({ "a.ts": "a" });
    const quarantine = join(mkdtempSync(join(tmpdir(), "quarantine-")), "quarantine");
    mkdirSync(join(root, "generated"));
    writeFileSync(join(root, "generated", "new.ts"), "created");
    const moved = await new FileSystemWatchedFiles(root, quarantine).quarantine(["generated/new.ts"]);
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.value.startsWith(`${quarantine}/`)).toBe(true);
    expect(existsSync(join(root, "generated", "new.ts"))).toBe(false);
    expect(readFileSync(join(moved.value, "generated", "new.ts"), "utf8")).toBe("created");
    expect(statSync(join(moved.value, "generated", "new.ts")).mode & 0o777).toBe(0o600);
    expect(statSync(moved.value).mode & 0o777).toBe(0o700);
    expect(statSync(join(moved.value, "generated")).mode & 0o777).toBe(0o700);
  });

  test("never enters node_modules or .git, at any depth, nor a linked directory: a linked node_modules over a large tree is skipped quickly", async () => {
    const root = repository({ "src/a.ts": "a" });
    const large = mkdtempSync(join(tmpdir(), "large-tree-"));
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(large, `pkg${i}`, "lib"), { recursive: true });
      for (let j = 0; j < 50; j++) writeFileSync(join(large, `pkg${i}`, "lib", `f${j}.js`), "x");
    }
    symlinkSync(large, join(root, "node_modules"), "dir");
    mkdirSync(join(root, "src", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "src", "node_modules", "dep", "index.js"), "x");
    symlinkSync(large, join(root, "src", "vendor"), "dir");
    const started = performance.now();
    const hashed = await filesAt(root).hash([rule("**")]);
    expect(performance.now() - started).toBeLessThan(2000);
    if (!hashed.ok) throw new Error(hashed.error);
    const paths = Object.keys(hashed.value);
    expect(paths.some((path) => path.split("/").includes("node_modules"))).toBe(false);
    expect(paths.some((path) => path.startsWith("src/vendor/"))).toBe(false);
    expect(paths).toContain("src/a.ts");
  });

  test("a link a rule matches is recorded as a link, by where it points, and never followed", async () => {
    const root = repository({ "src/a.ts": "a" });
    symlinkSync("a.ts", join(root, "src", "alias.ts"));
    const hashed = await filesAt(root).hash([rule("src/**")]);
    if (!hashed.ok) throw new Error(hashed.error);
    expect(hashed.value["src/alias.ts"]?.link).toBe(true);
    expect(hashed.value["src/alias.ts"]?.hash).not.toBe(hashed.value["src/a.ts"]?.hash);
    expect(hashed.value["src/a.ts"]?.link).toBeUndefined();
  });

  test("restores the executable bit, from a copy and from the commit", async () => {
    const root = repository({ "run.sh": "#!/bin/sh\n" });
    chmodSync(join(root, "run.sh"), 0o755);
    spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-am", "executable"], { cwd: root });
    writeFileSync(join(root, "tool.sh"), "#!/bin/sh\necho\n", { mode: 0o755 });
    const files = filesAt(root);
    const head = await files.head();
    const copied = await files.copy("tool.sh");
    if (!head.ok || head.value === null || !copied.ok) throw new Error("expected a commit and a copy");
    expect(copied.value.executable).toBe(true);
    for (const path of ["run.sh", "tool.sh"]) {
      rmSync(join(root, path));
      writeFileSync(join(root, path), "tampered", { mode: 0o644 });
    }
    expect(await files.restore("run.sh", { from: "commit", commit: head.value })).toEqual({ ok: true, value: undefined });
    expect(await files.restore("tool.sh", { from: "copy", content: copied.value.content, executable: true })).toEqual({ ok: true, value: undefined });
    expect(statSync(join(root, "run.sh")).mode & 0o100).toBe(0o100);
    expect(statSync(join(root, "tool.sh")).mode & 0o100).toBe(0o100);
  });
});
