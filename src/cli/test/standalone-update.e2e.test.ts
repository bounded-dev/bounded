import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function run(f: Fixture, args: readonly string[], executable = f.binary): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([executable, ...args], { cwd: f.project, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: join(f.root, "fake-bin"), MANAGER_LOG: f.managerLog, XDG_DATA_HOME: f.dataHome,
      LOCALAPPDATA: f.dataHome, XDG_STATE_HOME: join(f.root, "state"), CLAUDE_PROJECT_DIR: f.project } });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function installPriorTestRelease(f: Fixture): { readonly binary: string; readonly version: string } {
  const version = "3.2.9";
  const target = targetId();
  const currentRelease = join(f.dataHome, "bounded", "releases", `v${f.version}`, target);
  const priorRelease = join(f.dataHome, "bounded", "releases", `v${version}`, target);
  cpSync(currentRelease, priorRelease, { recursive: true });
  const entry = join(f.root, "prior-standalone-entry.ts");
  writeFileSync(entry, `import { dispatchStandalone } from ${JSON.stringify(join(REPO, "src", "standalone-dispatch.ts"))};\nconst version = ${JSON.stringify(version)};\nconst args = process.argv.slice(2);\nconst dispatched = await dispatchStandalone(args, version);\nif (!dispatched.answered) { if (args[0] === "--version") console.log(version); else { const { runStandaloneRuntime } = await import(${JSON.stringify(join(REPO, "src", "standalone-runtime.ts"))}); await runStandaloneRuntime(args, version, dispatched.hostProjectRoot); } }\n`);
  const binary = join(priorRelease, "bin", process.platform === "win32" ? "bounded.exe" : "bounded");
  rmSync(binary);
  const wasm = join(REPO, "node_modules", "@vscode", "tree-sitter-wasm", "wasm");
  const typeEnvironment = join(REPO, "src", "dist", "standalone", "bounded-type-environment-bytes.bin");
  const built = Bun.spawnSync([process.execPath, "build", entry, "--compile", "--asset", join(wasm, "tree-sitter.wasm"),
    "--asset", join(wasm, "tree-sitter-bash.wasm"), "--asset", typeEnvironment, "--outfile", binary],
    { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`prior release build failed: ${built.stderr.toString()}`);
  if (process.platform !== "win32") chmodSync(binary, 0o755);
  const identified = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (identified.exitCode !== 0 || identified.stdout.toString().trim() !== version)
    throw new Error(`synthetic prior executable identifies as ${identified.stdout.toString().trim()}: ${identified.stderr.toString()}`);
  const currentReceipt = JSON.parse(readFileSync(join(f.dataHome, "bounded", "receipts", `v${f.version}`, target, "receipt-v1.json"), "utf8")) as { manifestSha256: string };
  const currentManifestPath = join(f.dataHome, "bounded", "receipts", `v${f.version}`, target, "manifests", `${currentReceipt.manifestSha256}.json`);
  const manifest = JSON.parse(readFileSync(currentManifestPath, "utf8")) as Parameters<typeof verifyReleaseArchive>[0];
  const releaseIdentityPath = join(priorRelease, "release.json");
  const identity = JSON.parse(readFileSync(releaseIdentityPath, "utf8")) as Record<string, unknown>;
  writeFileSync(releaseIdentityPath, `${JSON.stringify({ ...identity, version })}\n`);
  const archive = manifest.targets[target];
  if (archive === undefined) throw new Error("test release lacks native target");
  const changed = {
    ...manifest, version,
    targets: { ...manifest.targets, [target]: {
      ...archive,
      archive: { ...archive.archive, name: archive.archive.name.replace(`v${f.version}`, `v${version}`) },
      executable: { ...archive.executable, size: readFileSync(binary).byteLength, sha256: sha256(readFileSync(binary)) },
      files: archive.files.map((file) => file.path === "release.json"
        ? { ...file, size: readFileSync(releaseIdentityPath).byteLength, sha256: sha256(readFileSync(releaseIdentityPath)) } : file),
    } },
  };
  const stable = Buffer.from(`${JSON.stringify(changed)}\n`);
  const hash = sha256(stable);
  const receipt = join(f.dataHome, "bounded", "receipts", `v${version}`, target);
  mkdirSync(join(receipt, "manifests"), { recursive: true });
  writeFileSync(join(receipt, "manifests", `${hash}.json`), stable);
  writeFileSync(join(receipt, "receipt-v1.json"), `${JSON.stringify({ schema: "bounded-install-receipt/1", version, target, manifestSha256: hash })}\n`);
  return { binary, version };
}

function updateJournalForCurrentProject(f: Fixture): object {
  const paths = [".claude/settings.json", ".pi/extensions/bounded/index.ts", ".bounded/version.json"];
  return {
    schema: "bounded-update-journal/1", source: { kind: "standalone", version: f.version }, targetVersion: f.version,
    sourceFiles: { [realpathSync(join(f.project, "bounded.config.ts"))]: sha256(readFileSync(join(f.project, "bounded.config.ts"))) },
    files: paths.map((path) => {
      const absolute = join(f.project, path);
      const state = { content: readFileSync(absolute).toString("base64"), mode: lstatSync(absolute).mode & 0o777 };
      return { path, before: { ...state }, after: { ...state } };
    }),
  };
}

interface RecoveryJournalFixture {
  source: { kind: "standalone"; version: string };
  targetVersion: string;
  sourceFiles: Record<string, string>;
  readonly files: { path: string; before: { content: string; mode: number }; after: { content: string; mode: number } }[];
}

async function preparedCrossVersionJournal(f: Fixture): Promise<{
  readonly journal: RecoveryJournalFixture;
  readonly settingsPath: string;
  readonly loaderPath: string;
  readonly pinPath: string;
  readonly targetSettings: Uint8Array;
}> {
  const prior = installPriorTestRelease(f);
  const initialized = run(f, ["init", "--host", "claude-code", "--host", "pi"], prior.binary);
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
  const settingsPath = join(f.project, ".claude", "settings.json");
  const loaderPath = join(f.project, ".pi", "extensions", "bounded", "index.ts");
  const pinPath = join(f.project, ".bounded", "version.json");
  const generated = await import("../../hosts/claude-code/standalone-install.ts");
  const prepared = await generated.prepareStandaloneClaudeHooks(f.project, realpathSync(f.binary),
    { recognizedPriorExecutable: realpathSync(prior.binary) });
  if (!prepared.ok) throw new Error(prepared.error);
  const journal = updateJournalForCurrentProject(f) as RecoveryJournalFixture;
  journal.source.version = prior.version;
  journal.targetVersion = f.version;
  const claude = journal.files.find((file) => file.path === ".claude/settings.json");
  const pi = journal.files.find((file) => file.path === ".pi/extensions/bounded/index.ts");
  const pin = journal.files.find((file) => file.path === ".bounded/version.json");
  if (claude === undefined || pi === undefined || pin === undefined) throw new Error("journal lacks host files or pin");
  const piLoader = await import("../../hosts/pi/standalone-install.ts");
  claude.after.content = Buffer.from(prepared.value.nextBytes).toString("base64");
  pi.after.content = Buffer.from(piLoader.standalonePiLoader(realpathSync(f.binary))).toString("base64");
  pin.after.content = Buffer.from(`${JSON.stringify({ schema: "bounded-project-version/1", version: f.version })}\n`).toString("base64");
  return { journal, settingsPath, loaderPath, pinPath, targetSettings: Buffer.from(prepared.value.nextBytes) };
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
    const originalConfig = readFileSync(join(f.project, "bounded.config.ts"), "utf8");
    writeFileSync(join(f.project, "bounded.config.ts"), `${originalConfig}\nconst updateSemanticMismatch: string = 42;\n`);
    const settings = readFileSync(join(f.project, ".claude", "settings.json"));
    const loader = readFileSync(join(f.project, ".pi", "extensions", "bounded", "index.ts"));
    const pin = readFileSync(join(f.project, ".bounded", "version.json"));
    const answer = run(f, ["update"]);
    expect(answer.exitCode).not.toBe(0);
    expect(answer.stderr).toContain("TS2322");
    expect(answer.stderr).toContain("bounded.config.ts");
    expect(readFileSync(join(f.project, ".claude", "settings.json"))).toEqual(settings);
    expect(readFileSync(join(f.project, ".pi", "extensions", "bounded", "index.ts"))).toEqual(loader);
    expect(readFileSync(join(f.project, ".bounded", "version.json"))).toEqual(pin);
    expect(existsSync(f.managerLog)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);

test("update preflights each installed host's ports and names the host whose wiring conflicts", async () => {
  const f = await fixture();
  try {
    const hostSpecificConfig = 'import { defineConfig, Ports } from "bounded/domain";\nimport { prereqs } from "bounded/prereqs";\nimport { FileSystemPrerequisiteStatusSnapshots } from "bounded/prereqs/adapters";\nexport default defineConfig({ packs: [prereqs], ports: [Ports.provide(prereqs.optionalPorts.prerequisiteStatusSnapshots, root => new FileSystemPrerequisiteStatusSnapshots(root))] });\n';
    rmSync(join(f.project, ".claude"), { recursive: true, force: true });
    expect(run(f, ["init", "--host", "pi"]).exitCode).toBe(0);
    writeFileSync(join(f.project, "bounded.config.ts"), hostSpecificConfig);
    expect(run(f, ["update"]).exitCode).toBe(0);
    expect(run(f, ["check"]).exitCode).toBe(0);
    const before = readFileSync(join(f.project, ".bounded", "version.json"));
    // Install the exact generated Claude hook set without changing the existing configuration.
    mkdirSync(join(f.project, ".claude"));
    const generated = await import("../../hosts/claude-code/standalone-install.ts");
    const prepared = await generated.prepareStandaloneClaudeHooks(f.project, realpathSync(f.binary));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect((await prepared.value.install()).ok).toBe(true);
    const settings = readFileSync(join(f.project, ".claude", "settings.json"));
    const answer = run(f, ["update"]);
    expect(answer.exitCode).not.toBe(0);
    expect(answer.stderr).toContain("Claude Code");
    expect(answer.stderr).toContain("prerequisiteStatusSnapshots");
    expect(readFileSync(join(f.project, ".bounded", "version.json"))).toEqual(before);
    expect(readFileSync(join(f.project, ".claude", "settings.json"))).toEqual(settings);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);

test("update reclaims a provably dead writer and refuses a live writer without replacing hosts", async () => {
  const f = await fixture();
  try {
    expect(run(f, ["init", "--host", "claude-code", "--host", "pi"]).exitCode).toBe(0);
    const writer = join(f.project, ".bounded", ".update-writer");
    mkdirSync(writer);
    writeFileSync(join(writer, "owner.json"), '{"pid":2147483647,"nonce":"00000000-0000-4000-8000-000000000001"}\n');
    const recovered = run(f, ["update"]);
    expect(recovered.exitCode).toBe(0);
    expect(existsSync(writer)).toBe(false);
    mkdirSync(writer);
    writeFileSync(join(writer, "owner.json"), `${JSON.stringify({ pid: process.pid, nonce: "00000000-0000-4000-8000-000000000002" })}\n`);
    const settings = readFileSync(join(f.project, ".claude", "settings.json"));
    const refused = run(f, ["update"]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(/writer|busy|owner/i);
    expect(readFileSync(join(f.project, ".claude", "settings.json"))).toEqual(settings);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);

test("pending update journal blocks check before project configuration can run", async () => {
  const f = await fixture();
  try {
    expect(run(f, ["init", "--host", "claude-code", "--host", "pi"]).exitCode).toBe(0);
    const sentinel = join(f.project, "config-executed.txt");
    const originalConfig = readFileSync(join(f.project, "bounded.config.ts"), "utf8");
    writeFileSync(join(f.project, "bounded.config.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\n${originalConfig}`);
    writeFileSync(join(f.project, ".bounded", "update-journal.json"), "{malformed\n");
    const checked = run(f, ["check"]);
    expect(checked.exitCode).not.toBe(0);
    expect(checked.stderr).toContain("update-journal.json");
    expect(existsSync(sentinel)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);

test("recovery refuses a linked Claude ancestor even when its target bytes match the journal", async () => {
  const f = await fixture();
  try {
    expect(run(f, ["init", "--host", "claude-code", "--host", "pi"]).exitCode).toBe(0);
    const journal = join(f.project, ".bounded", "update-journal.json");
    writeFileSync(journal, `${JSON.stringify(updateJournalForCurrentProject(f))}\n`);
    const originalClaude = join(f.project, ".claude");
    const outside = join(f.root, "outside-claude");
    renameSync(originalClaude, outside);
    symlinkSync(outside, originalClaude, process.platform === "win32" ? "junction" : "dir");
    const outsideSettings = readFileSync(join(outside, "settings.json"));
    const recovered = run(f, ["update"]);
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toMatch(/link|symlink|linked/i);
    expect(existsSync(journal)).toBe(true);
    expect(readFileSync(join(outside, "settings.json"))).toEqual(outsideSettings);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);

test("recovery restores the old host after a crash following the first host replacement", async () => {
  const f = await fixture();
  try {
    const prior = installPriorTestRelease(f);
    const initialized = run(f, ["init", "--host", "claude-code", "--host", "pi"], prior.binary);
    expect(initialized.exitCode).toBe(0);
    expect(initialized.stdout).toContain(`Bounded ${prior.version} initialized`);
    const settingsPath = join(f.project, ".claude", "settings.json");
    const pinPath = join(f.project, ".bounded", "version.json");
    const oldSettings = readFileSync(settingsPath);
    const oldLoader = readFileSync(join(f.project, ".pi", "extensions", "bounded", "index.ts"));
    const oldPin = readFileSync(pinPath);
    const generated = await import("../../hosts/claude-code/standalone-install.ts");
    const prepared = await generated.prepareStandaloneClaudeHooks(f.project, realpathSync(f.binary),
      { recognizedPriorExecutable: realpathSync(prior.binary) });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const journal = updateJournalForCurrentProject(f) as RecoveryJournalFixture;
    journal.source.version = prior.version;
    journal.targetVersion = f.version;
    const claude = journal.files.find((file) => file.path === ".claude/settings.json");
    const pi = journal.files.find((file) => file.path === ".pi/extensions/bounded/index.ts");
    const pin = journal.files.find((file) => file.path === ".bounded/version.json");
    if (claude === undefined || pi === undefined || pin === undefined) throw new Error("journal lacks host files or pin");
    claude.after.content = Buffer.from(prepared.value.nextBytes).toString("base64");
    const piLoader = await import("../../hosts/pi/standalone-install.ts");
    pi.after.content = Buffer.from(piLoader.standalonePiLoader(realpathSync(f.binary))).toString("base64");
    pin.after.content = Buffer.from(`${JSON.stringify({ schema: "bounded-project-version/1", version: f.version })}\n`).toString("base64");
    expect(Buffer.from(pin.before.content, "base64").toString("utf8")).toBe(`${JSON.stringify({ schema: "bounded-project-version/1", version: prior.version })}\n`);
    expect(Buffer.from(pin.after.content, "base64").toString("utf8")).toBe(`${JSON.stringify({ schema: "bounded-project-version/1", version: f.version })}\n`);
    writeFileSync(settingsPath, prepared.value.nextBytes);
    const journalPath = join(f.project, ".bounded", "update-journal.json");
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
    const recovered = run(f, ["update"]);
    expect(recovered.exitCode).not.toBe(0);
    expect(readFileSync(settingsPath)).toEqual(oldSettings);
    expect(readFileSync(join(f.project, ".pi", "extensions", "bounded", "index.ts"))).toEqual(oldLoader);
    expect(readFileSync(pinPath)).toEqual(oldPin);
    expect(existsSync(journalPath)).toBe(false);
    const checkedAfterRestore = run(f, ["check"]);
    if (checkedAfterRestore.exitCode !== 0) throw new Error(checkedAfterRestore.stderr);
    expect(checkedAfterRestore.exitCode).toBe(0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);

test("recovery keeps its marker if the recorded old Claude hook is not a valid generated set", async () => {
  const f = await fixture();
  try {
    expect(run(f, ["init", "--host", "claude-code", "--host", "pi"]).exitCode).toBe(0);
    const settingsPath = join(f.project, ".claude", "settings.json");
    const generated = await import("../../hosts/claude-code/standalone-install.ts");
    const prepared = await generated.prepareStandaloneClaudeHooks(f.project, realpathSync(f.binary),
      { recognizedPriorExecutable: realpathSync(f.binary) });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const journal = updateJournalForCurrentProject(f) as RecoveryJournalFixture;
    const claude = journal.files.find((file) => file.path === ".claude/settings.json");
    if (claude === undefined) throw new Error("journal lacks Claude settings");
    const forged = JSON.parse(Buffer.from(claude.before.content, "base64").toString("utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const command = forged.hooks.PreToolUse?.[0]?.hooks[0];
    if (command === undefined) throw new Error("journal lacks old PreToolUse hook");
    command.command += " # edited";
    claude.before.content = Buffer.from(`${JSON.stringify(forged)}\n`).toString("base64");
    claude.after.content = Buffer.from(prepared.value.nextBytes).toString("base64");
    writeFileSync(settingsPath, prepared.value.nextBytes);
    const targetSettings = readFileSync(settingsPath);
    const journalPath = join(f.project, ".bounded", "update-journal.json");
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
    const recovered = run(f, ["update"]);
    expect(recovered.exitCode).not.toBe(0);
    expect(recovered.stderr).toMatch(/hook|journal|recover/i);
    expect(existsSync(journalPath)).toBe(true);
    expect(readFileSync(settingsPath)).toEqual(targetSettings);
    expect(run(f, ["check"]).exitCode).not.toBe(0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);

test("recovery uses the journal's previous release after a torn update has already written the target pin", async () => {
  const f = await fixture();
  try {
    const prior = installPriorTestRelease(f);
    expect(run(f, ["init", "--host", "claude-code", "--host", "pi"], prior.binary).exitCode).toBe(0);
    const settingsPath = join(f.project, ".claude", "settings.json");
    const loaderPath = join(f.project, ".pi", "extensions", "bounded", "index.ts");
    const pinPath = join(f.project, ".bounded", "version.json");
    const oldSettings = readFileSync(settingsPath);
    const oldLoader = readFileSync(loaderPath);
    const oldPin = readFileSync(pinPath);
    expect(oldPin.toString("utf8")).toBe(`${JSON.stringify({ schema: "bounded-project-version/1", version: prior.version })}\n`);
    const generated = await import("../../hosts/claude-code/standalone-install.ts");
    const prepared = await generated.prepareStandaloneClaudeHooks(f.project, realpathSync(f.binary),
      { recognizedPriorExecutable: realpathSync(prior.binary) });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const journal = updateJournalForCurrentProject(f) as RecoveryJournalFixture;
    journal.source.version = prior.version;
    journal.targetVersion = f.version;
    const claude = journal.files.find((file) => file.path === ".claude/settings.json");
    const pin = journal.files.find((file) => file.path === ".bounded/version.json");
    if (claude === undefined || pin === undefined) throw new Error("journal lacks Claude settings or pin");
    claude.after.content = Buffer.from(prepared.value.nextBytes).toString("base64");
    const pi = journal.files.find((file) => file.path === ".pi/extensions/bounded/index.ts");
    if (pi === undefined) throw new Error("journal lacks Pi loader");
    const piLoader = await import("../../hosts/pi/standalone-install.ts");
    pi.after.content = Buffer.from(piLoader.standalonePiLoader(realpathSync(f.binary))).toString("base64");
    pin.after.content = Buffer.from(`${JSON.stringify({ schema: "bounded-project-version/1", version: f.version })}\n`).toString("base64");
    writeFileSync(settingsPath, prepared.value.nextBytes);
    writeFileSync(pinPath, Buffer.from(pin.after.content, "base64"));
    const journalPath = join(f.project, ".bounded", "update-journal.json");
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
    const recovered = run(f, ["update"]);
    expect(recovered.exitCode).not.toBe(0);
    expect(readFileSync(settingsPath)).toEqual(oldSettings);
    expect(readFileSync(loaderPath)).toEqual(oldLoader);
    expect(readFileSync(pinPath)).toEqual(oldPin);
    expect(existsSync(journalPath)).toBe(false);
    const checkedAfterRestore = run(f, ["check"], prior.binary);
    if (checkedAfterRestore.exitCode !== 0) throw new Error(checkedAfterRestore.stderr);
    expect(checkedAfterRestore.exitCode).toBe(0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);

for (const recoveryPhase of ["restored source", "committed target"] as const) {
  test(`recovery retains its marker when ${recoveryPhase} semantic preflight edits a host`, async () => {
    const f = await fixture();
    try {
      const prepared = await preparedCrossVersionJournal(f);
      const configPath = join(f.project, "bounded.config.ts");
      const sentinelPath = join(f.project, "recovery-config-executed.txt");
      const editedSettings = "edited during recovery verification\n";
      const originalConfig = readFileSync(configPath, "utf8");
      writeFileSync(configPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinelPath)}, "ran");\nwriteFileSync(${JSON.stringify(prepared.settingsPath)}, ${JSON.stringify(editedSettings)});\n${originalConfig}`);
      prepared.journal.sourceFiles = { [realpathSync(configPath)]: sha256(readFileSync(configPath)) };
      writeFileSync(prepared.settingsPath, prepared.targetSettings);
      if (recoveryPhase === "committed target") {
        const pi = prepared.journal.files.find((file) => file.path === ".pi/extensions/bounded/index.ts");
        const pin = prepared.journal.files.find((file) => file.path === ".bounded/version.json");
        if (pi === undefined || pin === undefined) throw new Error("journal lacks target Pi loader or pin");
        writeFileSync(prepared.loaderPath, Buffer.from(pi.after.content, "base64"));
        writeFileSync(prepared.pinPath, Buffer.from(pin.after.content, "base64"));
      }
      const journalPath = join(f.project, ".bounded", "update-journal.json");
      writeFileSync(journalPath, `${JSON.stringify(prepared.journal)}\n`);
      const recovered = run(f, ["update"]);
      expect(recovered.exitCode).not.toBe(0);
      expect(existsSync(sentinelPath)).toBe(true);
      expect(existsSync(journalPath)).toBe(true);
      expect(readFileSync(prepared.settingsPath, "utf8")).toBe(editedSettings);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 240_000);
}

test("a published npm installation migrates to the archive executable without changing config or npm bytes", async () => {
  const f = await fixture();
  try {
    const archive = join(import.meta.dir, "fixtures", "bounded-published-3.3.0.tgz");
    expect(sha256(readFileSync(archive))).toBe("f79adce31f1148d578874b35d4099ef205bf5ba72068e71eac88fab27b2aeaa3");
    const extracted = join(f.root, "published-package");
    mkdirSync(extracted);
    const unpack = Bun.spawnSync(["tar", "-xzf", archive, "-C", extracted], { stdout: "pipe", stderr: "pipe" });
    expect(unpack.exitCode).toBe(0);
    const modules = join(f.project, "node_modules");
    mkdirSync(modules);
    cpSync(join(extracted, "package"), join(modules, "bounded"), { recursive: true });
    for (const name of ["@vscode/tree-sitter-wasm", "picomatch", "zod"]) {
      const target = join(modules, name);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(REPO, "node_modules", name), target, { recursive: true });
    }
    writeFileSync(join(f.project, "package.json"), '{"name":"python-project","private":true,"version":"1.0.0","dependencies":{"bounded":"3.3.0"}}\n');
    // npm-generated once from the pinned published package; the consumer run stays offline.
    writeFileSync(join(f.project, "package-lock.json"), readFileSync(join(import.meta.dir, "fixtures", "bounded-published-3.3.0-package-lock.json")));
    const oldCli = Bun.spawnSync(["node", join(modules, "bounded", "dist", "cli.js"), "init", "--no-install"], {
      cwd: f.project, stdout: "pipe", stderr: "pipe", env: process.env,
    });
    expect(oldCli.exitCode).toBe(0);
    const config = readFileSync(join(f.project, "bounded.config.ts"));
    const manifest = readFileSync(join(f.project, "package.json"));
    const lock = readFileSync(join(f.project, "package-lock.json"));
    const oldSettings = readFileSync(join(f.project, ".claude", "settings.json"), "utf8");
    const oldLoader = readFileSync(join(f.project, ".pi", "extensions", "bounded", "index.ts"), "utf8");
    expect(oldSettings).toContain("node_modules/bounded/dist/hosts/claude-code/hook.js");
    expect(oldLoader).toBe(readFileSync(join(import.meta.dir, "fixtures", "bounded-3.3.0-pi-loader.txt"), "utf8"));
    const result = run(f, ["update"]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(f.project, "bounded.config.ts"))).toEqual(config);
    expect(readFileSync(join(f.project, "package.json"))).toEqual(manifest);
    expect(readFileSync(join(f.project, "package-lock.json"))).toEqual(lock);
    expect(readFileSync(join(f.project, ".claude", "settings.json"), "utf8")).not.toContain("node_modules/bounded/dist/hosts/claude-code/hook.js");
    expect(readFileSync(join(f.project, ".pi", "extensions", "bounded", "index.ts"), "utf8")).toContain("hook pi --project");
    expect(JSON.parse(readFileSync(join(f.project, ".bounded", "version.json"), "utf8"))).toEqual({ schema: "bounded-project-version/1", version: f.version });
    expect(run(f, ["check"]).exitCode).toBe(0);
    expect(existsSync(f.managerLog)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);
