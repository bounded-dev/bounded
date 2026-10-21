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
  mkdirSync(join(project, ".claude"));
  mkdirSync(join(project, ".pi"));
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

test("published npm closure refuses changed installed dependency identity and missing declared transitive dependency", async () => {
  await withPublishedProject((project, closure) => {
    const manifestPath = join(project, "node_modules", "zod", "package.json");
    const original = readFileSync(manifestPath);
    const manifest = JSON.parse(original.toString("utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: "9.9.9" })}\n`);
    expect(closure.captureInstalledNpmClosure(project).ok).toBe(false);
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, dependencies: { "not-installed": "1.0.0" } })}\n`);
    expect(closure.captureInstalledNpmClosure(project).ok).toBe(false);
    writeFileSync(manifestPath, original);
    const captured = closure.captureInstalledNpmClosure(project);
    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error(captured.error);
    mkdirSync(join(project, "node_modules", "zod", "extra-directory"));
    expect(closure.reverifyInstalledNpmClosure(project, captured.value).ok).toBe(false);
  });
}, 120_000);

test("published npm closure refuses alternate config selection and changed known dynamic loader", async () => {
  await withPublishedProject((project, closure) => {
    writeFileSync(join(project, "bounded.config.mjs"), "export default {};\n");
    expect(closure.captureInstalledNpmClosure(project).ok).toBe(false);
    rmSync(join(project, "bounded.config.mjs"));
    const loader = join(project, "node_modules", "bounded", "dist", "core", "adapters", "out", "index.js");
    writeFileSync(loader, `${readFileSync(loader, "utf8")}\n// changed installed loader\n`);
    expect(closure.captureInstalledNpmClosure(project).ok).toBe(false);
  });
}, 120_000);

test("published npm closure parses the pinned runtime and rejects edited dependency code even when imports are decoys", async () => {
  await withPublishedProject((project, closure) => {
    const main = join(project, "node_modules", "picomatch", "index.js");
    const original = readFileSync(main, "utf8");
    expect(original).toContain("require('./lib/picomatch')");
    expect(closure.captureInstalledNpmClosure(project).ok).toBe(true);
    writeFileSync(main, `${original}\n// require('./missing-comment.js')\nconst ignored = "import('./missing-string.js')";\n`);
    const edited = closure.captureInstalledNpmClosure(project);
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.error).toMatch(/picomatch|published|digest|changed/i);
  });
}, 120_000);

test("published npm closure rejects forged file path, hash, and package identity in journal snapshot", async () => {
  await withPublishedProject((project, closure) => {
    const captured = closure.captureInstalledNpmClosure(project);
    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error(captured.error);
    const snapshot = JSON.parse(JSON.stringify(captured.value)) as {
      files: Record<string, { sha256: string }>;
      packages: Record<string, { name: string; version: string }>;
    };
    const file = Object.keys(snapshot.files).find((path) => path.endsWith("node_modules/bounded/package.json"));
    expect(file).toBeDefined();
    if (file === undefined) return;
    const withBadHash = structuredClone(snapshot);
    const fileRecord = withBadHash.files[file];
    if (fileRecord === undefined) throw new Error("captured snapshot lacks bounded package.json");
    withBadHash.files[file] = { ...fileRecord, sha256: "0".repeat(64) };
    expect(closure.reverifyInstalledNpmClosure(project, withBadHash).ok).toBe(false);
    const withBadPath = structuredClone(snapshot);
    withBadPath.files["../outside"] = fileRecord;
    expect(closure.reverifyInstalledNpmClosure(project, withBadPath).ok).toBe(false);
    const withBadIdentity = structuredClone(snapshot);
    const boundedIdentity = withBadIdentity.packages["node_modules/bounded"];
    if (boundedIdentity === undefined) throw new Error("captured snapshot lacks bounded identity");
    withBadIdentity.packages["node_modules/bounded"] = { ...boundedIdentity, version: "9.9.9" };
    expect(closure.reverifyInstalledNpmClosure(project, withBadIdentity).ok).toBe(false);
  });
}, 120_000);

test("published npm closure refuses an alias or eval loader added to an installed dependency", async () => {
  await withPublishedProject((project, closure) => {
    const main = join(project, "node_modules", "picomatch", "index.js");
    const original = readFileSync(main, "utf8");
    writeFileSync(main, `${original}\nconst hiddenRequire = eval('require'); hiddenRequire('./outside.js');\n`);
    expect(closure.captureInstalledNpmClosure(project).ok).toBe(false);
    writeFileSync(main, `${original}\nconst alias = require; alias('./outside.js');\n`);
    expect(closure.captureInstalledNpmClosure(project).ok).toBe(false);
  });
}, 120_000);

test("published npm closure rejects a symlinked project root", async () => {
  await withPublishedProject((project, closure) => {
    expect(closure.captureInstalledNpmClosure(project).ok).toBe(true);
    const linkedRoot = `${project}-linked`;
    symlinkSync(project, linkedRoot, "dir");
    try {
      const result = closure.captureInstalledNpmClosure(linkedRoot);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/root|link|symlink/i);
    } finally { rmSync(linkedRoot); }
  });
}, 120_000);

test("published npm closure does not resolve through a false node_modules/node_modules shadow", async () => {
  await withPublishedProject((project, closure) => {
    const realDependency = join(project, "node_modules", "picomatch");
    const shadowDependency = join(project, "node_modules", "node_modules", "picomatch");
    mkdirSync(dirname(shadowDependency), { recursive: true });
    cpSync(realDependency, shadowDependency, { recursive: true });
    rmSync(realDependency, { recursive: true, force: true });
    const lockPath = join(project, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages: Record<string, unknown> };
    lock.packages["node_modules/node_modules/picomatch"] = lock.packages["node_modules/picomatch"];
    delete lock.packages["node_modules/picomatch"];
    writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);
    const result = closure.captureInstalledNpmClosure(project);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/picomatch|installed|resolve/i);
  });
}, 120_000);
