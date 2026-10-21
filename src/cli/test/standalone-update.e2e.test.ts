import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { verifyReleaseArchive } from "../release-manifest.ts";

const REPO = resolve(import.meta.dir, "../../..");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function targetId(): string {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "win32") return `windows-${process.arch}`;
  if (process.platform !== "linux") throw new Error(`No native release target for ${process.platform}`);
  const ldd = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
  const output = `${ldd.stdout.toString()} ${ldd.stderr.toString()}`.toLowerCase();
  if (output.includes("musl")) return `linux-${process.arch}-musl`;
  if (output.includes("glibc") || output.includes("gnu libc")) return `linux-${process.arch}-gnu`;
  throw new Error("Cannot identify native libc");
}

interface Fixture {
  readonly root: string;
  readonly binary: string;
  readonly project: string;
  readonly dataHome: string;
  readonly managerLog: string;
  readonly version: string;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "bounded-standalone-update-"));
  const release = join(root, "release");
  const target = targetId();
  const built = Bun.spawnSync([process.execPath, join(REPO, "src", "build-release.ts"), "--target", target, "--smoke", "--out", release], {
    cwd: REPO, stdout: "pipe", stderr: "pipe",
  });
  if (built.exitCode !== 0) throw new Error(`release build failed: ${built.stdout.toString()}${built.stderr.toString()}`);
  const version = (JSON.parse(readFileSync(join(REPO, "src", "package.json"), "utf8")) as { version: string }).version;
  const manifest = JSON.parse(readFileSync(join(release, `bounded-v${version}-manifest-v1.json`), "utf8")) as Parameters<typeof verifyReleaseArchive>[0];
  const archive = manifest.targets[target];
  if (archive === undefined) throw new Error(`release lacks ${target}`);
  const files = await verifyReleaseArchive(manifest, target, readFileSync(join(release, archive.archive.name)));
  if (!files.ok) throw new Error(files.error);
  const dataHome = join(root, "data-home");
  const installed = join(dataHome, "bounded", "releases", `v${version}`, target);
  for (const [path, bytes] of Object.entries(files.value)) {
    const destination = join(installed, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  const binary = join(installed, archive.executable.path);
  if (process.platform !== "win32") chmodSync(binary, 0o755);
  const stableManifest = Buffer.from(`${JSON.stringify({ ...manifest, channel: "stable" })}\n`);
  const manifestHash = sha256(stableManifest);
  const receiptDir = join(dataHome, "bounded", "receipts", `v${version}`, target);
  mkdirSync(join(receiptDir, "manifests"), { recursive: true });
  writeFileSync(join(receiptDir, "manifests", `${manifestHash}.json`), stableManifest);
  writeFileSync(join(receiptDir, "receipt-v1.json"), `${JSON.stringify({ schema: "bounded-install-receipt/1", version, target, manifestSha256: manifestHash })}\n`);
  const project = join(root, "python project");
  mkdirSync(join(project, ".claude"), { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(project, "main.py"), "print('ok')\n");
  const fakeBin = join(root, "fake-bin");
  const managerLog = join(root, "manager.log");
  mkdirSync(fakeBin);
  for (const name of ["node", "npm", "npx", "bun", "bunx", "pnpm", "yarn"]) {
    const file = join(fakeBin, process.platform === "win32" ? `${name}.cmd` : name);
    writeFileSync(file, process.platform === "win32" ? `@echo off\r\necho ${name}>>"%MANAGER_LOG%"\r\nexit /b 83\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$MANAGER_LOG"\nexit 83\n`);
    if (process.platform !== "win32") chmodSync(file, 0o755);
  }
  return { root, binary, project, dataHome, managerLog, version };
}

function run(f: Fixture, args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([f.binary, ...args], { cwd: f.project, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: join(f.root, "fake-bin"), MANAGER_LOG: f.managerLog, XDG_DATA_HOME: f.dataHome,
      LOCALAPPDATA: f.dataHome, XDG_STATE_HOME: join(f.root, "state"), CLAUDE_PROJECT_DIR: f.project } });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("archive-only same-version update refreshes installed hosts after semantic preflight and remains idempotent", async () => {
  const f = await fixture();
  try {
    expect(run(f, ["init", "--host", "claude-code", "--host", "pi"]).exitCode).toBe(0);
    const config = readFileSync(join(f.project, "bounded.config.ts"));
    const first = run(f, ["update"]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain(f.version);
    expect(readFileSync(join(f.project, "bounded.config.ts"))).toEqual(config);
    expect(run(f, ["check"]).exitCode).toBe(0);
    const settings = readFileSync(join(f.project, ".claude", "settings.json"));
    const loader = readFileSync(join(f.project, ".pi", "extensions", "bounded", "index.ts"));
    expect(run(f, ["update"]).exitCode).toBe(0);
    expect(readFileSync(join(f.project, ".claude", "settings.json"))).toEqual(settings);
    expect(readFileSync(join(f.project, ".pi", "extensions", "bounded", "index.ts"))).toEqual(loader);
    expect(existsSync(f.managerLog)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);

test("update refuses a configuration type error before changing any installed host or pin", async () => {
  const f = await fixture();
  try {
    expect(run(f, ["init", "--host", "claude-code", "--host", "pi"]).exitCode).toBe(0);
    writeFileSync(join(f.project, "bounded.config.ts"), 'import { missing } from "bounded/domain";\nexport default missing;\n');
    const settings = readFileSync(join(f.project, ".claude", "settings.json"));
    const loader = readFileSync(join(f.project, ".pi", "extensions", "bounded", "index.ts"));
    const pin = readFileSync(join(f.project, ".bounded", "version.json"));
    const answer = run(f, ["update"]);
    expect(answer.exitCode).not.toBe(0);
    expect(answer.stderr).toMatch(/TS2305|missing|bounded\.config\.ts/i);
    expect(readFileSync(join(f.project, ".claude", "settings.json"))).toEqual(settings);
    expect(readFileSync(join(f.project, ".pi", "extensions", "bounded", "index.ts"))).toEqual(loader);
    expect(readFileSync(join(f.project, ".bounded", "version.json"))).toEqual(pin);
    expect(existsSync(f.managerLog)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);
