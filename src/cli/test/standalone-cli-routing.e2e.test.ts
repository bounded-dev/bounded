import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { verifyReleaseArchive } from "../release-manifest.ts";

const REPO = resolve(import.meta.dir, "../../..");

function nativeTarget(): string {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "win32") return `windows-${process.arch}`;
  if (process.platform === "linux") {
    const ldd = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
    const report = `${ldd.stdout.toString()} ${ldd.stderr.toString()}`.toLowerCase();
    if (report.includes("musl")) return `linux-${process.arch}-musl`;
    if (report.includes("glibc") || report.includes("gnu libc")) return `linux-${process.arch}-gnu`;
  }
  throw new Error(`No native standalone target for ${process.platform}/${process.arch}`);
}

function successful(command: readonly string[], cwd: string): void {
  const [program, ...args] = command;
  if (program === undefined) throw new Error("No program to run");
  const ran = Bun.spawnSync([program, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${ran.stdout.toString()}${ran.stderr.toString()}`);
}

interface Fixture {
  readonly root: string;
  readonly binary: string;
  readonly releaseIdentity: string;
  readonly project: string;
  readonly managerLog: string;
  readonly version: string;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "bounded-standalone-cli-routing-"));
  const source = join(root, "build-checkout");
  const release = join(root, "release");
  const project = join(root, "python project");
  const fakeBin = join(root, "fake-bin");
  const managerLog = join(root, "package-manager.log");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(project, "main.py"), "print('hello')\n");
  writeFileSync(join(project, ".claude", "settings.json"), '{"hooks":{},"custom":true}\n');
  // A package-manager fallback has an observable effect even when it later refuses.
  for (const name of ["npm", "npx", "bun", "bunx", "pnpm", "yarn", "node"]) {
    const path = join(fakeBin, process.platform === "win32" ? `${name}.cmd` : name);
    writeFileSync(path, process.platform === "win32"
      ? `@echo off\r\necho ${name}>>"%MANAGER_LOG%"\r\nexit /b 83\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$MANAGER_LOG"\nexit 83\n`);
    if (process.platform !== "win32") chmodSync(path, 0o755);
  }
  successful(["git", "clone", "--quiet", "--no-hardlinks", REPO, source], REPO);
  cpSync(join(REPO, "src"), join(source, "src"), { recursive: true, force: true });
  cpSync(join(REPO, "bun.lock"), join(source, "bun.lock"), { force: true });
  // Compile against the checked-out workspace dependencies, then remove this
  // build checkout before executing the archive's binary.
  symlinkSync(join(REPO, "node_modules"), join(source, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const target = nativeTarget();
  successful([process.execPath, join(source, "src", "build-release.ts"), "--target", target, "--smoke", "--out", release], source);
  const version = (JSON.parse(readFileSync(join(source, "src", "package.json"), "utf8")) as { version: string }).version;
  const manifest = JSON.parse(readFileSync(join(release, `bounded-v${version}-manifest-v1.json`), "utf8")) as Parameters<typeof verifyReleaseArchive>[0];
  const entry = manifest.targets[target];
  if (entry === undefined) throw new Error(`release lacks ${target}`);
  const verified = await verifyReleaseArchive(manifest, target, readFileSync(join(release, entry.archive.name)));
  if (!verified.ok) throw new Error(verified.error);
  const installed = join(root, "installed");
  mkdirSync(installed);
  for (const [path, contents] of Object.entries(verified.value)) {
    const destination = join(installed, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  const binary = join(installed, entry.executable.path);
  if (!existsSync(binary)) throw new Error("verified release lacks executable");
  if (process.platform !== "win32") chmodSync(binary, 0o755);
  const releaseIdentity = join(installed, "release.json");
  if (!existsSync(releaseIdentity)) throw new Error("verified release lacks release.json");
  rmSync(source, { recursive: true, force: true });
  rmSync(release, { recursive: true, force: true });
  expect(existsSync(source)).toBe(false);
  return { root, binary, releaseIdentity, project, managerLog, version };
}

function run(f: Fixture, args: readonly string[], cwd = f.project, stdin?: string): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } {
  const executable = Bun.spawnSync([f.binary, ...args], {
    cwd,
    env: { ...process.env, PATH: join(f.root, "fake-bin"), MANAGER_LOG: f.managerLog, XDG_STATE_HOME: join(f.root, "state"), CLAUDE_PROJECT_DIR: f.project },
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
    stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: executable.exitCode, stdout: executable.stdout.toString(), stderr: executable.stderr.toString() };
}

function projectBytes(f: Fixture): { readonly python: string; readonly settings: string; readonly configExists: boolean; readonly pinExists: boolean } {
  return {
    python: readFileSync(join(f.project, "main.py"), "utf8"),
    settings: readFileSync(join(f.project, ".claude", "settings.json"), "utf8"),
    configExists: existsSync(join(f.project, "bounded.config.ts")),
    pinExists: existsSync(join(f.project, ".bounded", "version.json")),
  };
}

test("archive-only executable routes each distribution command locally or refuses before npm CLI and project mutation", async () => {
  const f = await fixture();
  try {
    expect(run(f, ["--version"])).toMatchObject({ exitCode: 0, stdout: `${f.version}\n`, stderr: "" });
    const before = projectBytes(f);
    for (const args of [
      ["init", "--host", "claude-code"], ["init", "--host", "pi"], ["update"], ["check"],
      ["host", "pi"], ["catalog", "build"], ["unknown"], ["init", "--no-install"],
    ]) {
      const answer = run(f, args);
      expect(answer.exitCode).not.toBe(0);
      expect(answer.stderr).toMatch(/standalone|executable|unsupported|unavailable/i);
      expect(answer.stdout).not.toContain("handed over");
      expect(projectBytes(f)).toEqual(before);
      expect(existsSync(f.managerLog)).toBe(false);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 240_000);

test("an unavailable requested host in a Python project refuses before writing config, pin or hooks", async () => {
  const f = await fixture();
  try {
    expect(existsSync(join(f.project, "package.json"))).toBe(false);
    const before = projectBytes(f);
    const answer = run(f, ["init", "--host", "claude-code"]);
    expect(answer.exitCode).not.toBe(0);
    expect(answer.stderr).toMatch(/claude-code.*(?:installer|unavailable)|(?:installer|unavailable).*claude-code/i);
    expect(projectBytes(f)).toEqual(before);
    expect(existsSync(f.managerLog)).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 240_000);

test("init rejects missing or malformed executable release identity before changing a Python project", async () => {
  const f = await fixture();
  try {
    const before = projectBytes(f);
    for (const identity of [null, "not json\n", '{}\n']) {
      if (identity === null) rmSync(f.releaseIdentity, { force: true });
      else writeFileSync(f.releaseIdentity, identity);
      const answer = run(f, ["init", "--host", "claude-code"]);
      expect(answer.exitCode).not.toBe(0);
      expect(answer.stderr).toMatch(/release\.json|release identity|release metadata/i);
      expect(projectBytes(f)).toEqual(before);
      expect(existsSync(f.managerLog)).toBe(false);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 240_000);
