import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifyReleaseArchive } from "../../../cli/release-manifest.ts";

const REPO = resolve(import.meta.dir, "../../../..");
const PI_VERSION = "0.87.1";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const nativeTarget = (): string => {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "win32") return `windows-${process.arch}`;
  const probe = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
  const output = `${probe.stdout.toString()} ${probe.stderr.toString()}`.toLowerCase();
  if (output.includes("musl")) return `linux-${process.arch}-musl`;
  if (output.includes("glibc") || output.includes("gnu libc")) return `linux-${process.arch}-gnu`;
  throw new Error("Native Linux libc is unknown");
};

interface Archive { readonly root: string; readonly executable: string; readonly version: string; readonly fakeBin: string; readonly managerLog: string }
let archive: Archive;
beforeAll(async () => {
  const piFixture = join(REPO, "src", "hosts", "pi", "test", "fixtures", "pi-runtime");
  const installedPi = join(piFixture, "node_modules", PI_PACKAGE, "package.json");
  if (!existsSync(installedPi) && process.env.PI_CODING_AGENT_DIR === undefined) {
    const npm = Bun.which(process.platform === "win32" ? "npm.cmd" : "npm");
    if (npm === null) throw new Error("The pinned Pi 0.87.1 test fixture requires npm during CI setup");
    const install = Bun.spawnSync([npm, "ci", "--prefix", piFixture, "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    if (install.exitCode !== 0) throw new Error(`Pinned Pi 0.87.1 fixture install failed: ${install.stderr.toString()}`);
  }
  const root = mkdtempSync(join(tmpdir(), "bounded-standalone-pi-"));
  const built = Bun.spawnSync([process.execPath, join(REPO, "src", "build-release.ts"), "--target", nativeTarget(), "--smoke", "--out", root], {
    cwd: REPO, stdout: "pipe", stderr: "pipe",
  });
  if (built.exitCode !== 0) throw new Error(`Compiled Pi archive failed: ${built.stderr.toString()}`);
  const version = (JSON.parse(readFileSync(join(REPO, "src", "package.json"), "utf8")) as { version: string }).version;
  const manifest = JSON.parse(readFileSync(join(root, `bounded-v${version}-manifest-v1.json`), "utf8")) as Parameters<typeof verifyReleaseArchive>[0];
  const entry = manifest.targets[nativeTarget()];
  if (entry === undefined) throw new Error("Native Pi archive target is missing");
  const verified = await verifyReleaseArchive(manifest, nativeTarget(), readFileSync(join(root, entry.archive.name)));
  if (!verified.ok) throw new Error(verified.error);
  const installed = join(root, "installed");
  for (const [path, bytes] of Object.entries(verified.value)) {
    const target = join(installed, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const executable = join(installed, entry.executable.path);
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  const fakeBin = join(root, "fake-bin");
  const managerLog = join(root, "manager.log");
  mkdirSync(fakeBin);
  for (const name of ["node", "bun", "npm", "npx", "bunx"]) {
    const path = join(fakeBin, process.platform === "win32" ? `${name}.cmd` : name);
    writeFileSync(path, process.platform === "win32" ? `@echo off\r\necho ${name}>>"%MANAGER_LOG%"\r\nexit /b 83\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$MANAGER_LOG"\nexit 83\n`);
    if (process.platform !== "win32") chmodSync(path, 0o755);
  }
  archive = { root, executable, version, fakeBin, managerLog };
}, 240_000);
afterAll(() => { if (archive !== undefined) rmSync(archive.root, { recursive: true, force: true }); });

function project(hosts: readonly string[] = ["pi"]): string {
  const root = mkdtempSync(join(archive.root, "python-project-"));
  writeFileSync(join(root, "main.py"), "print('hello')\n");
  if (hosts.includes("pi")) mkdirSync(join(root, ".pi"));
  if (hosts.includes("claude-code")) mkdirSync(join(root, ".claude"));
  return root;
}

function bounded(root: string, args: readonly string[]): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const run = Bun.spawnSync([archive.executable, ...args], { cwd: root,
    env: { ...process.env, PATH: archive.fakeBin, MANAGER_LOG: archive.managerLog, XDG_STATE_HOME: join(archive.root, "state") },
    stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function piRuntime(): string {
  const root = process.env.PI_CODING_AGENT_DIR ?? join(REPO, "src", "hosts", "pi", "test", "fixtures", "pi-runtime", "node_modules", PI_PACKAGE);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string; version?: string; dependencies?: Record<string, string> };
  expect(manifest.name).toBe(PI_PACKAGE);
  expect(manifest.version).toBe(PI_VERSION);
  expect(manifest.dependencies?.jiti).toBe("2.7.0");
  return root;
}

function invokeUnderPi(root: string, body: string): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const pi = piRuntime(); // Required CI fixture, never a skip-if-installed gate.
  const nodeBinary = process.env.PI_NODE_BINARY ?? Bun.which("node");
  if (nodeBinary === null) throw new Error("The pinned Pi CI runtime requires Node for Pi itself");
  const script = join(root, "pi-runtime.mjs");
  writeFileSync(script, `import { pathToFileURL } from "node:url";
const piLoader = await import(pathToFileURL(${JSON.stringify(join(pi, "dist", "core", "extensions", "loader.js"))}).href);
const piBus = await import(pathToFileURL(${JSON.stringify(join(pi, "dist", "core", "event-bus.js"))}).href);
const bus = piBus.createEventBus();
const loaded = await piLoader.loadExtensions([${JSON.stringify(join(root, ".pi", "extensions", "bounded", "index.ts"))}], process.cwd(), bus);
if (loaded.errors.length !== 0 || loaded.extensions.length !== 1) throw new Error(JSON.stringify(loaded.errors));
const handlers = new Map([...loaded.extensions[0].handlers].map(([name, values]) => [name, values[0]]));
${body}\n`);
  const run = Bun.spawnSync([nodeBinary, script], {
    cwd: root, env: { ...process.env, PATH: archive.fakeBin, MANAGER_LOG: archive.managerLog, XDG_STATE_HOME: join(archive.root, "state") },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

test("verified archive initializes Pi alone and both hosts without a project package manager", () => {
  const pi = project();
  const installed = bounded(pi, ["init", "--host", "pi"]);
  expect(installed.code).toBe(0);
  const loader = readFileSync(join(pi, ".pi", "extensions", "bounded", "index.ts"), "utf8");
  expect(loader).toContain("hook pi");
  expect(loader).toContain(archive.executable);
  expect(loader).not.toMatch(/(?:import\s*\(\s*|from\s+)["']bounded(?:\/|["'])/);
  expect(loader).not.toMatch(/(?:spawn|exec)(?:Sync|File)?\s*\(\s*["'](?:node|bun|npm|npx)/);
  expect(existsSync(join(pi, "package.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(pi, ".bounded", "version.json"), "utf8"))).toEqual({ schema: "bounded-project-version/1", version: archive.version });
  expect(existsSync(archive.managerLog)).toBe(false);

  const both = project(["pi", "claude-code"]);
  expect(bounded(both, ["init", "--host", "claude-code", "--host", "pi"]).code).toBe(0);
  expect(existsSync(join(both, ".pi", "extensions", "bounded", "index.ts"))).toBe(true);
  expect(readFileSync(join(both, ".claude", "settings.json"), "utf8")).toContain("hook claude-code");
  expect(existsSync(archive.managerLog)).toBe(false);
}, 240_000);

test("pinned real Pi loads the generated bridge and the compiled worker judges and records a rule", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const denied = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "pi-1", toolName: "edit", input: { path: "bounded.config.ts", oldText: "x", newText: "y" } }, { cwd: process.cwd() });
const allowed = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "pi-2", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ denied, allowed, events: [...handlers.keys()] }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { denied?: { block?: boolean; reason?: string }; allowed?: { block?: boolean }; events: string[] };
  expect(answer.denied?.block).toBe(true);
  expect(answer.denied?.reason).toContain("the rule '**/bounded.config.*' from bounded/project");
  expect(answer.allowed?.block).not.toBe(true);
  expect(answer.events).toEqual(expect.arrayContaining(["session_start", "tool_call", "tool_result"]));
  const log = readFileSync(join(root, ".bounded", "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { verdict: { kind: string } });
  expect(log.at(-2)?.verdict.kind).toBe("refuse");
  expect(log.at(-1)?.verdict.kind).toBe("allow");
  expect(existsSync(archive.managerLog)).toBe(false);
}, 240_000);

test("long-lived Pi bridge refuses a changed project source before reusing its session composition", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const first = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "before", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
const fs = await import("node:fs");
fs.appendFileSync("bounded.config.ts", "\\n// modified during this Pi session\\n");
const second = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "after", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ first, second }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { first?: { block?: boolean }; second?: { block?: boolean; reason?: string } };
  expect(answer.first?.block).not.toBe(true);
  expect(answer.second?.block).toBe(true);
  expect(answer.second?.reason).toMatch(/changed|restart|snapshot/i);
}, 240_000);

test("Pi result is paired with its accepted call snapshot and warns when after-tool checking cannot run", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const call = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "paired-call", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
const fs = await import("node:fs");
fs.appendFileSync("bounded.config.ts", "\\n// changed after call\\n");
const patch = await handlers.get("tool_result")({ type: "tool_result", toolCallId: "paired-call", toolName: "read", input: { path: "main.py" }, content: [{ type: "text", text: "done" }], isError: false }, { cwd: process.cwd() });
console.log(JSON.stringify({ call, patch }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { call?: { block?: boolean }; patch?: { isError?: boolean; content?: { text?: string }[] } };
  expect(answer.call?.block).not.toBe(true);
  expect(answer.patch?.isError).toBe(true);
  expect(JSON.stringify(answer.patch?.content)).toMatch(/changed|snapshot|after.tool/i);
}, 240_000);

test("Pi bridge notices newly pending managed projection state before another call", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const first = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "before", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
const fs = await import("node:fs");
fs.writeFileSync(".bounded/types-journal.json", "{pending}");
const second = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "after", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ first, second }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { first?: { block?: boolean }; second?: { block?: boolean; reason?: string } };
  expect(answer.first?.block).not.toBe(true);
  expect(answer.second?.block).toBe(true);
  expect(answer.second?.reason).toMatch(/projection|journal|restart|changed/i);
}, 240_000);

test("real Pi loader registers a blocking handler even when the installed executable is missing", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const missing = `${archive.executable}.missing`;
  renameSync(archive.executable, missing);
  try {
    const result = invokeUnderPi(root, `
const events = [...handlers.keys()];
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const answer = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "missing", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ events, answer }));`);
    expect(result.code).toBe(0);
    const answer = JSON.parse(result.stdout.trim()) as { events: string[]; answer?: { block?: boolean; reason?: string } };
    expect(answer.events).toContain("tool_call");
    expect(answer.answer?.block).toBe(true);
    expect(answer.answer?.reason).toMatch(/executable|install|restart/i);
    expect(existsSync(archive.managerLog)).toBe(false);
  } finally { renameSync(missing, archive.executable); }
}, 240_000);
