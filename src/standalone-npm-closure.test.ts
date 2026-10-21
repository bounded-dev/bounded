import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";

const repo = resolve(import.meta.dir, "..");
const publishedFixtures = join(repo, "src", "cli", "test", "fixtures");
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type ClosureModule = typeof import("./standalone-npm-closure.ts");
async function closureModule(): Promise<ClosureModule | null> {
  try { return await import("./standalone-npm-closure.ts"); }
  catch (error) {
    if (error instanceof Error && /Cannot find module|Cannot resolve module/.test(error.message)) return null;
    throw error;
  }
}

function publishedNpmProject(): string {
  const project = mkdtempSync(join(tmpdir(), "bounded-published-npm-closure-"));
  const modules = join(project, "node_modules");
  mkdirSync(modules);
  const untar = Bun.spawnSync(["tar", "-xzf", join(publishedFixtures, "bounded-published-3.3.0.tgz"), "-C", project], { stdout: "pipe", stderr: "pipe" });
  if (untar.exitCode !== 0) throw new Error(`published tar fixture failed: ${untar.stderr.toString()}`);
  cpSync(join(project, "package"), join(modules, "bounded"), { recursive: true });
  rmSync(join(project, "package"), { recursive: true, force: true });
  for (const name of ["@vscode/tree-sitter-wasm", "picomatch", "zod"]) {
    const destination = join(modules, name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repo, "node_modules", name), destination, { recursive: true });
  }
  writeFileSync(join(project, "package.json"), '{"name":"python-project","private":true,"version":"1.0.0","dependencies":{"bounded":"3.3.0"}}\n');
  cpSync(join(publishedFixtures, "bounded-published-3.3.0-package-lock.json"), join(project, "package-lock.json"));
  const oldCli = Bun.spawnSync(["node", join(modules, "bounded", "dist", "cli.js"), "init", "--no-install"], {
    cwd: project, stdout: "pipe", stderr: "pipe", env: process.env,
  });
  if (oldCli.exitCode !== 0) throw new Error(`published 3.3.0 init failed: ${oldCli.stderr.toString()}`);
  return project;
}

async function withPublishedProject(run: (project: string, closure: ClosureModule) => void | Promise<void>): Promise<void> {
  const closure = await closureModule();
  expect(closure).not.toBeNull();
  if (closure === null) return;
  const project = publishedNpmProject();
  try { await run(project, closure); }
  finally { rmSync(project, { recursive: true, force: true }); }
}

test("published npm 3.3.0 default Claude and Pi runtime captures and reverifies the full installed closure", async () => {
  await withPublishedProject((project, closure) => {
    const settings = readFileSync(join(project, ".claude", "settings.json"), "utf8");
    const pi = readFileSync(join(project, ".pi", "extensions", "bounded", "index.ts"), "utf8");
    expect(settings).toContain("node_modules/bounded/dist/hosts/claude-code/hook.js");
    expect(pi).toBe(readFileSync(join(publishedFixtures, "bounded-3.3.0-pi-loader.txt"), "utf8"));
    const result = closure.captureInstalledNpmClosure(project);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const snapshot = result.value;
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain("3.3.0");
    expect(serialized).toContain("node_modules/bounded");
    expect(serialized).toContain("node_modules/@vscode/tree-sitter-wasm");
    expect(serialized).toContain("node_modules/picomatch");
    expect(serialized).toContain("node_modules/zod");
    expect(serialized).toContain("bounded.config.ts");
    expect(serialized).not.toContain(project);
    expect(closure.reverifyInstalledNpmClosure(project, JSON.parse(serialized))).toEqual({ ok: true, value: undefined });
  });
}, 120_000);

test("published npm closure detects byte edits, new files, links, and changed config at restoration", async () => {
  await withPublishedProject((project, closure) => {
    const original = closure.captureInstalledNpmClosure(project);
    expect(original.ok).toBe(true);
    if (!original.ok) throw new Error(original.error);
    const boundedFile = join(project, "node_modules", "bounded", "dist", "hosts", "claude-code", "hook.js");
    writeFileSync(boundedFile, `${readFileSync(boundedFile, "utf8")}\n// edited\n`);
    expect(closure.reverifyInstalledNpmClosure(project, original.value).ok).toBe(false);
    const unchanged = publishedNpmProject();
    try {
      const baseline = closure.captureInstalledNpmClosure(unchanged);
      expect(baseline.ok).toBe(true);
      if (!baseline.ok) throw new Error(baseline.error);
      writeFileSync(join(unchanged, "node_modules", "picomatch", "unexpected.js"), "export {};\n");
      expect(closure.reverifyInstalledNpmClosure(unchanged, baseline.value).ok).toBe(false);
      rmSync(join(unchanged, "node_modules", "picomatch", "unexpected.js"));
      symlinkSync("index.js", join(unchanged, "node_modules", "picomatch", "linked.js"));
      expect(closure.reverifyInstalledNpmClosure(unchanged, baseline.value).ok).toBe(false);
      rmSync(join(unchanged, "node_modules", "picomatch", "linked.js"));
      writeFileSync(join(unchanged, "bounded.config.ts"), `${readFileSync(join(unchanged, "bounded.config.ts"), "utf8")}\n`);
      expect(closure.reverifyInstalledNpmClosure(unchanged, baseline.value).ok).toBe(false);
    } finally { rmSync(unchanged, { recursive: true, force: true }); }
  });
}, 120_000);

test("published npm closure refuses edited config, extra project packages, and unsupported lock or package identities", async () => {
  await withPublishedProject((project, closure) => {
    const config = join(project, "bounded.config.ts");
    writeFileSync(config, `import "node:fs";\n${readFileSync(config, "utf8")}`);
    expect(closure.captureInstalledNpmClosure(project).ok).toBe(false);
    const clean = publishedNpmProject();
    try {
      const manifest = join(clean, "package.json");
      const root = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
      writeFileSync(manifest, `${JSON.stringify({ ...root, devDependencies: { extra: "1.0.0" } })}\n`);
      expect(closure.captureInstalledNpmClosure(clean).ok).toBe(false);
      writeFileSync(manifest, readFileSync(join(project, "package.json")));
      const lockPath = join(clean, "package-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
      writeFileSync(lockPath, `${JSON.stringify({ ...lock, lockfileVersion: 2 })}\n`);
      expect(closure.captureInstalledNpmClosure(clean).ok).toBe(false);
    } finally { rmSync(clean, { recursive: true, force: true }); }
  });
}, 120_000);

test("published npm closure refuses unresolved, computed and native imports in an installed runtime dependency", async () => {
  await withPublishedProject((project, closure) => {
    const picomatchMain = join(project, "node_modules", "picomatch", "index.js");
    const original = readFileSync(picomatchMain, "utf8");
    for (const added of ["require('./missing.js');", "require(process.env.BOUNDED_MODULE);", "require('./addon.node');", "import(`./${name}.js`);"]) {
      writeFileSync(picomatchMain, `${original}\n${added}\n`);
      expect(closure.captureInstalledNpmClosure(project).ok).toBe(false);
    }
    writeFileSync(picomatchMain, original);
    const packagePath = join(project, "node_modules", "picomatch", "package.json");
    const json = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    writeFileSync(packagePath, `${JSON.stringify({ ...json, peerDependencies: { missing: "1.0.0" } })}\n`);
    expect(closure.captureInstalledNpmClosure(project).ok).toBe(false);
  });
}, 120_000);

test("published npm closure rejects forged journal snapshot and a changed project lock byte", async () => {
  await withPublishedProject((project, closure) => {
    const captured = closure.captureInstalledNpmClosure(project);
    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error(captured.error);
    const forged = JSON.parse(JSON.stringify(captured.value)) as Record<string, unknown>;
    forged.schema = "other";
    expect(closure.reverifyInstalledNpmClosure(project, forged).ok).toBe(false);
    const lockPath = join(project, "package-lock.json");
    const before = readFileSync(lockPath);
    writeFileSync(lockPath, Buffer.concat([before, Buffer.from("\n")]));
    expect(closure.reverifyInstalledNpmClosure(project, captured.value).ok).toBe(false);
    expect(digest(before)).not.toBe(digest(readFileSync(lockPath)));
    expect(existsSync(join(project, ".claude", "settings.json"))).toBe(true);
  });
}, 120_000);
