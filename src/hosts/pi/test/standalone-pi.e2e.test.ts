import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { verifyReleaseArchive } from "../../../cli/release-manifest.ts";
import { sha512Integrity, type TarEntry } from "../../../cli/managed-pack-artifact.test-support.ts";
import { runStandaloneAddInternal } from "../../../standalone-runtime.ts";
import { piLoader } from "../install.ts";

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

interface Archive { readonly root: string; readonly executable: string; readonly version: string; readonly fakeBin: string; readonly managerLog: string; readonly dataHome: string }
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
  const dataHome = join(root, "user-data");
  const installed = join(dataHome, "bounded", "releases", `v${version}`, nativeTarget());
  for (const [path, bytes] of Object.entries(verified.value)) {
    const target = join(installed, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const executable = join(installed, entry.executable.path);
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  const stableManifestBytes = new TextEncoder().encode(`${JSON.stringify({ ...manifest, channel: "stable" })}\n`);
  const manifestSha256 = createHash("sha256").update(stableManifestBytes).digest("hex");
  const receipts = join(dataHome, "bounded", "receipts", `v${version}`, nativeTarget());
  mkdirSync(join(receipts, "manifests"), { recursive: true });
  writeFileSync(join(receipts, "manifests", `${manifestSha256}.json`), stableManifestBytes);
  writeFileSync(join(receipts, "receipt-v1.json"), `${JSON.stringify({ schema: "bounded-install-receipt/1", version, target: nativeTarget(), manifestSha256 })}\n`);
  const fakeBin = join(root, "fake-bin");
  const managerLog = join(root, "manager.log");
  mkdirSync(fakeBin);
  for (const name of ["node", "bun", "npm", "npx", "bunx"]) {
    const path = join(fakeBin, process.platform === "win32" ? `${name}.cmd` : name);
    writeFileSync(path, process.platform === "win32" ? `@echo off\r\necho ${name}>>"%MANAGER_LOG%"\r\nexit /b 83\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$MANAGER_LOG"\nexit 83\n`);
    if (process.platform !== "win32") chmodSync(path, 0o755);
  }
  archive = { root, executable, version, fakeBin, managerLog, dataHome };
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
    env: { ...process.env, PATH: archive.fakeBin, MANAGER_LOG: archive.managerLog, XDG_STATE_HOME: join(archive.root, "state"),
      XDG_DATA_HOME: archive.dataHome, LOCALAPPDATA: archive.dataHome },
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

function invokeUnderPi(root: string, body: string, options: { readonly failBusOn?: boolean } = {}): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const pi = piRuntime(); // Required CI fixture, never a skip-if-installed gate.
  const nodeBinary = process.env.PI_NODE_BINARY ?? Bun.which("node");
  if (nodeBinary === null) throw new Error("The pinned Pi CI runtime requires Node for Pi itself");
  const script = join(root, "pi-runtime.mjs");
  writeFileSync(script, `import { pathToFileURL } from "node:url";
const piLoader = await import(pathToFileURL(${JSON.stringify(join(pi, "dist", "core", "extensions", "loader.js"))}).href);
const piBus = await import(pathToFileURL(${JSON.stringify(join(pi, "dist", "core", "event-bus.js"))}).href);
const actualBus = piBus.createEventBus();
const channels = [];
const bus = { ...actualBus, on(name, handler) { channels.push(name); ${options.failBusOn === true ? 'throw new Error("Pi event bus registration failed");' : 'return actualBus.on(name, handler);'} } };
const loaded = await piLoader.loadExtensions([${JSON.stringify(join(root, ".pi", "extensions", "bounded", "index.ts"))}], process.cwd(), bus);
if (loaded.errors.length !== 0 || loaded.extensions.length !== 1) throw new Error(JSON.stringify(loaded.errors));
const handlers = new Map([...loaded.extensions[0].handlers].map(([name, values]) => [name, values[0]]));
${body}\n`);
  const run = Bun.spawnSync([nodeBinary, script], {
    cwd: root, env: { ...process.env, PATH: archive.fakeBin, MANAGER_LOG: archive.managerLog, XDG_STATE_HOME: join(archive.root, "state"),
      XDG_DATA_HOME: archive.dataHome, LOCALAPPDATA: archive.dataHome },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function compiledFaultWorker(root: string, kind: "malformed" | "invalid-result" | "stalled" | "echo"): string {
  const source = join(root, `fault-worker-${kind}.ts`);
  const executable = join(root, process.platform === "win32" ? `fault-worker-${kind}.exe` : `fault-worker-${kind}`);
  writeFileSync(source, `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const kind = ${JSON.stringify(kind)};
appendFileSync(${JSON.stringify(join(root, `fault-worker-${kind}.starts`))}, String(process.pid) + "\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  appendFileSync(${JSON.stringify(join(root, `fault-worker-${kind}.frames`))}, line + "\\n");
  const frame = JSON.parse(line);
  if (kind === "malformed") { process.stdout.write("not-json\\n"); continue; }
  if (kind === "stalled" && frame.event !== "session_start") continue;
  const result = kind === "invalid-result" && frame.event === "tool_call" ? {} : null;
  process.stdout.write(JSON.stringify({ protocol: 1, id: frame.id, event: frame.event, result }) + "\\n");
}
`);
  const built = Bun.spawnSync([process.execPath, "build", "--compile", source, "--outfile", executable],
    { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`Native Pi fault worker fixture failed: ${built.stderr.toString()}`);
  return executable;
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

test("standalone Pi init migrates only the exact generated npm loader and preserves user edits", () => {
  const root = project();
  const loaderPath = join(root, ".pi", "extensions", "bounded", "index.ts");
  mkdirSync(dirname(loaderPath), { recursive: true });
  writeFileSync(loaderPath, piLoader().content);
  if (process.platform !== "win32") chmodSync(loaderPath, 0o600);
  const installed = bounded(root, ["init", "--host", "pi"]);
  expect(installed.code).toBe(0);
  expect(readFileSync(loaderPath, "utf8")).toContain(archive.executable);
  expect(readFileSync(loaderPath, "utf8")).not.toBe(piLoader().content);
  if (process.platform !== "win32") expect((statSync(loaderPath).mode & 0o777)).toBe(0o600);
  expect(JSON.parse(readFileSync(join(root, ".bounded", "version.json"), "utf8"))).toEqual({ schema: "bounded-project-version/1", version: archive.version });
  expect(existsSync(archive.managerLog)).toBe(false);

  const edited = project(["claude-code", "pi"]);
  const editedPath = join(edited, ".pi", "extensions", "bounded", "index.ts");
  mkdirSync(dirname(editedPath), { recursive: true });
  const userBytes = `${piLoader().content}\n// user edit\n`;
  writeFileSync(editedPath, userBytes);
  const refused = bounded(edited, ["init", "--host", "claude-code", "--host", "pi"]);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toMatch(/user edits|unknown loader/i);
  expect(readFileSync(editedPath, "utf8")).toBe(userBytes);
  expect(existsSync(join(edited, ".claude", "settings.json"))).toBe(false);
  expect(existsSync(join(edited, "bounded.config.ts"))).toBe(false);
  expect(existsSync(join(edited, ".bounded", "version.json"))).toBe(false);
}, 240_000);

test("compiled bounded check validates Pi-only and combined host projects", () => {
  for (const hosts of [["pi"], ["pi", "claude-code"]] as const) {
    const root = project(hosts);
    const init = bounded(root, ["init", ...hosts.flatMap((host) => ["--host", host])]);
    expect(init.code).toBe(0);
    const checked = bounded(root, ["check"]);
    expect(checked.code).toBe(0);
    expect(checked.stderr).toBe("");
    const loaderPath = join(root, ".pi", "extensions", "bounded", "index.ts");
    const originalLoader = readFileSync(loaderPath, "utf8");
    writeFileSync(loaderPath, `${originalLoader}\n// user changed the installed Pi bridge\n`);
    const changed = bounded(root, ["check"]);
    expect(changed.code).toBe(2);
    expect(changed.stderr).toMatch(/Pi|\.pi[/\\]extensions[/\\]bounded[/\\]index\.ts/i);
    expect(changed.stderr).toMatch(/changed|modified|unknown|repair|reinstall/i);
    writeFileSync(loaderPath, originalLoader);
    expect(bounded(root, ["check"]).code).toBe(0);
    expect(existsSync(archive.managerLog)).toBe(false);
  }
}, 240_000);

test("pinned real Pi loads the generated bridge and the compiled worker judges and records a rule", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const denied = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "pi-1", toolName: "edit", input: { path: "bounded.config.ts", oldText: "x", newText: "y" } }, { cwd: process.cwd() });
const allowed = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "pi-2", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ denied, allowed, events: [...handlers.keys()], channels }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { denied?: { block?: boolean; reason?: string }; allowed?: { block?: boolean }; events: string[]; channels: string[] };
  expect(answer.denied?.block).toBe(true);
  expect(answer.denied?.reason).toContain("the rule '**/bounded.config.*' from bounded/project");
  expect(answer.allowed?.block).not.toBe(true);
  expect(answer.events).toEqual(expect.arrayContaining(["session_start", "tool_call", "tool_result"]));
  expect(answer.channels).toContain("subagent:async-complete");
  const log = readFileSync(join(root, ".bounded", "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { verdict: { kind: string } });
  expect(log.at(-2)?.verdict.kind).toBe("refuse");
  expect(log.at(-1)?.verdict.kind).toBe("allow");
  expect(existsSync(archive.managerLog)).toBe(false);
}, 240_000);

test("generated Pi bridge passes its own initialized project root to the worker beside another project", () => {
  const root = project();
  const sibling = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  expect(bounded(sibling, ["init", "--host", "pi"]).code).toBe(0);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const answer = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "exact-root", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ answer }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { answer?: { block?: boolean } };
  expect(answer.answer?.block).not.toBe(true);
  expect(readFileSync(join(root, ".bounded", "log.jsonl"), "utf8")).toContain("exact-root");
  expect(existsSync(join(sibling, ".bounded", "log.jsonl"))).toBe(false);
}, 240_000);

test("the registered Pi guard blocks calls made before session_start", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const result = invokeUnderPi(root, `
const answer = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "too-early", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ answer }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { answer?: { block?: boolean; reason?: string } };
  expect(answer.answer?.block).toBe(true);
  expect(answer.answer?.reason).toMatch(/before session|session start|start a new/i);
  expect(existsSync(join(root, ".bounded", "log.jsonl"))).toBe(false);
}, 240_000);

test("Pi freezes original nested input before another extension can change the judged call", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const input = { path: "main.py", extra: { marker: "original" } };
const checking = handlers.get("tool_call")({ type: "tool_call", toolCallId: "frozen-input", toolName: "read", input }, { cwd: process.cwd() });
try { input.path = "bounded.config.ts"; } catch {}
try { input.extra.marker = "changed"; } catch {}
const answer = await checking;
console.log(JSON.stringify({ answer, input, frozen: Object.isFrozen(input) && Object.isFrozen(input.extra) }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { answer?: { block?: boolean }; input: { path: string; extra: { marker: string } }; frozen: boolean };
  expect(answer.frozen).toBe(true);
  expect(answer.input).toEqual({ path: "main.py", extra: { marker: "original" } });
  expect(answer.answer?.block).not.toBe(true);
  expect(readFileSync(join(root, ".bounded", "log.jsonl"), "utf8")).toContain("frozen-input");
}, 240_000);

test("compiled Pi worker reads Bash with its embedded grammar and refuses a protected hook write", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const denied = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "bash-hook", toolName: "bash", input: { command: "echo x > .git/hooks/pre-commit" } }, { cwd: process.cwd() });
const allowed = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "bash-notes", toolName: "bash", input: { command: "echo x > notes.txt" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ denied, allowed }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { denied?: { block?: boolean; reason?: string }; allowed?: { block?: boolean } };
  expect(answer.denied?.block).toBe(true);
  expect(answer.denied?.reason).toContain("the rule '.git/hooks/**' from bounded/project denies create of '.git/hooks/pre-commit'");
  expect(answer.allowed?.block).not.toBe(true);
  expect(existsSync(archive.managerLog)).toBe(false);
}, 240_000);

test("Pi tool_result restores a protected file changed after an accepted Bash call", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  writeFileSync(join(root, "guarded.txt"), "original guarded bytes\n");
  writeFileSync(join(root, "bounded.config.ts"), `import { contribution, defineConfig } from "bounded/domain";
import { protectedPathsPack } from "bounded/protected-paths";
export default defineConfig({ packs: [protectedPathsPack], contributes: [
  contribution(protectedPathsPack.points.protectedPaths, [
    { match: "guarded.txt", deny: ["modify"], why: "protected", redirect: "Ask a person" }
  ])
] });\n`);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const call = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "restore-1", toolName: "bash", input: { command: "echo x > notes.txt" } }, { cwd: process.cwd() });
const fs = await import("node:fs");
fs.writeFileSync("guarded.txt", "changed by tool\\n");
const patch = await handlers.get("tool_result")({ type: "tool_result", toolCallId: "restore-1", toolName: "bash", input: { command: "echo x > notes.txt" }, content: [{ type: "text", text: "done" }], isError: false }, { cwd: process.cwd() });
console.log(JSON.stringify({ call, patch, guardedBytes: fs.readFileSync("guarded.txt", "utf8") }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { call?: { block?: boolean }; patch?: { isError?: boolean; content?: { text?: string }[] }; guardedBytes: string };
  expect(answer.call?.block).not.toBe(true);
  expect(answer.patch?.isError).toBe(true);
  expect(JSON.stringify(answer.patch?.content)).toMatch(/restored|protected/i);
  expect(answer.guardedBytes).toBe("original guarded bytes\n");
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

test("Pi worker revalidates its installed release receipt before another call", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const receipt = join(archive.dataHome, "bounded", "receipts", `v${archive.version}`, nativeTarget(), "receipt-v1.json");
  const original = readFileSync(receipt);
  try {
    const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const first = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "release-before", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
const fs = await import("node:fs");
fs.writeFileSync(${JSON.stringify(receipt)}, "{}");
const second = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "release-after", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ first, second }));`);
    expect(result.code).toBe(0);
    const answer = JSON.parse(result.stdout.trim()) as { first?: { block?: boolean }; second?: { block?: boolean; reason?: string } };
    expect(answer.first?.block).not.toBe(true);
    expect(answer.second?.block).toBe(true);
    expect(answer.second?.reason).toMatch(/release|receipt|manifest|reinstall|restart/i);
  } finally { writeFileSync(receipt, original); }
}, 240_000);

test("Pi worker refuses a duplicate accepted tool call ID in one session", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const event = { type: "tool_call", toolCallId: "same-call", toolName: "read", input: { path: "main.py" } };
const first = await handlers.get("tool_call")(event, { cwd: process.cwd() });
const second = await handlers.get("tool_call")(event, { cwd: process.cwd() });
console.log(JSON.stringify({ first, second }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { first?: { block?: boolean }; second?: { block?: boolean; reason?: string } };
  expect(answer.first?.block).not.toBe(true);
  expect(answer.second?.block).toBe(true);
  expect(answer.second?.reason).toMatch(/duplicate|call id|already guarded/i);
}, 240_000);

test("Pi detects an edit to a transitive project-local config import during the same session", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  writeFileSync(join(root, "bounded.config.ts"), `import { contribution, defineConfig } from "bounded/domain";
import { protectedPathsPack } from "bounded/protected-paths";
import { rules } from "./rules.ts";
export default defineConfig({ packs: [protectedPathsPack], contributes: [contribution(protectedPathsPack.points.protectedPaths, rules)] });\n`);
  writeFileSync(join(root, "rules.ts"), `export const rules = [{ match: "**/main.py", deny: ["modify"], why: "protected", redirect: "Ask a person" }];\n`);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const first = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "before", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
const fs = await import("node:fs");
fs.appendFileSync("rules.ts", "\\n// edited transitive source\\n");
const second = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "after", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ first, second }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { first?: { block?: boolean }; second?: { block?: boolean; reason?: string } };
  expect(answer.first?.block).not.toBe(true);
  expect(answer.second?.block).toBe(true);
  expect(answer.second?.reason).toMatch(/rules\.ts|changed|restart|snapshot/i);
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

test("Pi's unawaited async completion is acknowledged before the next guarded tool call", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  writeFileSync(join(root, "bounded.config.ts"), `import { contribution, corePack, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
export default defineConfig({ packs: [corePack, prereqs], contributes: [
  contribution(prereqs.points.rules, [{ before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true },
    unchangedSince: [".agent-state/*/plan.md"], redirect: "Ask for plan review" }])
] });\n`);
  mkdirSync(join(root, ".agent-state", "item"), { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".agent-state", "item", "plan.md"), "the plan\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  const launch = JSON.parse(readFileSync(join(REPO, "src", "hosts", "pi", "test", "fixtures", "pi-subagents", "async-launch.tool-result.json"), "utf8"));
  const completion = JSON.parse(readFileSync(join(REPO, "src", "hosts", "pi", "test", "fixtures", "pi-subagents", "async-complete.json"), "utf8"));
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const review = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "call-review-1", toolName: "subagent", input: { agent: "plan-reviewer", task: "Review plans/plan.md" } }, { cwd: process.cwd() });
await handlers.get("tool_result")(${JSON.stringify(launch)}, { cwd: process.cwd() });
bus.emit("subagent:async-complete", ${JSON.stringify(completion)}); // Pi does not await this callback.
const edit = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "after-finish", toolName: "edit", input: { path: "src/a.ts", oldText: "a", newText: "b" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ review, edit }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { review?: { block?: boolean }; edit?: { block?: boolean; reason?: string } };
  expect(answer.review?.block).not.toBe(true);
  expect(answer.edit?.block).not.toBe(true);
  const lines = readFileSync(join(root, ".bounded", "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event?: string; tool?: string });
  const finish = lines.findIndex((line) => line.event === "agent-run-finished");
  const edit = lines.findIndex((line) => line.tool === "edit");
  expect(finish).toBeGreaterThanOrEqual(0);
  expect(edit).toBeGreaterThan(finish);
}, 240_000);

test("Pi extension reload disposes the prior worker and requires a fresh session", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const before = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "before", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
loaded.runtime.invalidate("Pi reloaded the extension");
const next = await piLoader.loadExtensions([${JSON.stringify(join(root, ".pi", "extensions", "bounded", "index.ts"))}], process.cwd(), bus);
if (next.errors.length !== 0 || next.extensions.length !== 1) throw new Error(JSON.stringify(next.errors));
const fresh = new Map([...next.extensions[0].handlers].map(([name, values]) => [name, values[0]]));
const stale = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "stale", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
await fresh.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const after = await fresh.get("tool_call")({ type: "tool_call", toolCallId: "after", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ before, stale, after }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { before?: { block?: boolean }; stale?: { block?: boolean }; after?: { block?: boolean } };
  expect(answer.before?.block).not.toBe(true);
  expect(answer.stale?.block).toBe(true);
  expect(answer.after?.block).not.toBe(true);
}, 240_000);

test("a second Pi session replaces and stops the prior compiled worker process", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const worker = compiledFaultWorker(root, "echo");
  const loaderPath = join(root, ".pi", "extensions", "bounded", "index.ts");
  writeFileSync(loaderPath, readFileSync(loaderPath, "utf8").replaceAll(archive.executable, worker));
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const first = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "session-one", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
await handlers.get("session_start")({ type: "session_start", reason: "new-session" }, { cwd: process.cwd() });
const second = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "session-two", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
const fs = await import("node:fs");
const starts = fs.readFileSync(${JSON.stringify(join(root, "fault-worker-echo.starts"))}, "utf8").trim().split("\\n");
const oldPid = Number(starts[0]);
let oldWorkerAlive = true;
for (let attempt = 0; attempt < 40; attempt++) {
  try { process.kill(oldPid, 0); } catch { oldWorkerAlive = false; break; }
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
}
console.log(JSON.stringify({ first, second, oldWorkerAlive }));
process.exit(0);`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { first?: { block?: boolean }; second?: { block?: boolean }; oldWorkerAlive: boolean };
  expect(answer.first?.block).not.toBe(true);
  expect(answer.second?.block).not.toBe(true);
  const starts = readFileSync(join(root, "fault-worker-echo.starts"), "utf8").trim().split("\n");
  expect(starts).toHaveLength(2);
  expect(new Set(starts).size).toBe(2);
  expect(answer.oldWorkerAlive).toBe(false);
}, 240_000);

test("compiled Pi worker rejects an incomplete tool-call frame before host adaptation", async () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const frames = [
    { protocol: 1, id: 1, event: "session_start", payload: { type: "session_start", reason: "startup" }, context: { cwd: root } },
    { protocol: 1, id: 2, event: "tool_call", payload: { type: "tool_call", toolCallId: "incomplete", toolName: "read" }, context: { cwd: root } },
  ];
  const run = Bun.spawn([archive.executable, "hook", "pi", "--project", root], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: archive.fakeBin, MANAGER_LOG: archive.managerLog, XDG_DATA_HOME: archive.dataHome,
      LOCALAPPDATA: archive.dataHome },
  });
  run.stdin.write(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
  run.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
  expect(exitCode).toBe(2);
  expect(stderr).toMatch(/Pi worker protocol failed:.*tool.call.*input/i);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  expect(existsSync(archive.managerLog)).toBe(false);
}, 240_000);

test("Pi bridge blocks a tool call when its child writes malformed protocol output", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const faulty = compiledFaultWorker(root, "malformed");
  const loaderPath = join(root, ".pi", "extensions", "bounded", "index.ts");
  const original = readFileSync(loaderPath, "utf8");
  expect(original).toContain(archive.executable);
  writeFileSync(loaderPath, original.replaceAll(archive.executable, faulty));
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const answer = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "bad-frame", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ answer }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { answer?: { block?: boolean; reason?: string } };
  expect(answer.answer?.block).toBe(true);
  expect(answer.answer?.reason).toMatch(/protocol|response|worker|malformed/i);
  expect(existsSync(archive.managerLog)).toBe(false);
}, 240_000);

test("Pi bridge rejects a structurally invalid worker allow response", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const faulty = compiledFaultWorker(root, "invalid-result");
  const received = join(root, "fault-worker-invalid-result.frames");
  const loaderPath = join(root, ".pi", "extensions", "bounded", "index.ts");
  writeFileSync(loaderPath, readFileSync(loaderPath, "utf8").replaceAll(archive.executable, faulty));
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const answer = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "invalid-answer", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ answer }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { answer?: { block?: boolean; reason?: string } };
  expect(readFileSync(received, "utf8").trim().split("\n")).toHaveLength(2);
  expect(answer.answer?.block).toBe(true);
  expect(answer.answer?.reason).toMatch(/worker response|worker result|protocol response/i);
}, 240_000);

test("Pi bridge refuses aggregate queued bytes before the stalled worker consumes them", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const faulty = compiledFaultWorker(root, "stalled");
  const loaderPath = join(root, ".pi", "extensions", "bounded", "index.ts");
  writeFileSync(loaderPath, readFileSync(loaderPath, "utf8").replaceAll(archive.executable, faulty));
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const payload = "a".repeat(300000);
for (let index = 0; index < 3; index++) void handlers.get("tool_call")({ type: "tool_call", toolCallId: "queued-" + index, toolName: "read", input: { path: "main.py", padding: payload } }, { cwd: process.cwd() });
const last = handlers.get("tool_call")({ type: "tool_call", toolCallId: "queued-overflow", toolName: "read", input: { path: "main.py", padding: payload } }, { cwd: process.cwd() });
const answer = await Promise.race([last, new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 1500))]);
console.log(JSON.stringify({ answer }));
process.exit(0);`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { answer?: { block?: boolean; reason?: string; timedOut?: boolean } };
  expect(answer.answer?.timedOut).not.toBe(true);
  expect(answer.answer?.block).toBe(true);
  expect(answer.answer?.reason).toMatch(/queue|queued|aggregate|capacity/i);
}, 240_000);

test("Pi bridge forwards only the needed context fields when Pi gives a cyclic host context", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const result = invokeUnderPi(root, `
const context = { cwd: process.cwd() };
context.self = context;
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);
const answer = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "cyclic-context", toolName: "read", input: { path: "main.py" } }, context);
console.log(JSON.stringify({ answer }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { answer?: { block?: boolean } };
  expect(answer.answer?.block).not.toBe(true);
}, 240_000);

test("Pi bridge blocks calls if Pi cannot register the async completion listener", () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const answer = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "no-bus", toolName: "read", input: { path: "main.py" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ answer, channels }));`, { failBusOn: true });
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { answer?: { block?: boolean; reason?: string }; channels: string[] };
  expect(answer.channels).toContain("subagent:async-complete");
  expect(answer.answer?.block).toBe(true);
  expect(answer.answer?.reason).toMatch(/event bus|completion|registration/i);
}, 240_000);

function packageEntries(root: string, path = ""): TarEntry[] {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) => {
    const name = path === "" ? entry.name : `${path}/${entry.name}`;
    if (entry.name === "node_modules" || entry.name === ".git" || name.startsWith("test/") || name.includes(".test.")) return [];
    if (entry.isDirectory()) return packageEntries(root, name);
    if (!entry.isFile()) throw new Error(`Unexpected published pack fixture entry ${name}`);
    return [{ name: `package/${name}`, body: readFileSync(join(root, name)) }];
  });
}

async function packedArtifact(files: readonly TarEntry[]): Promise<Uint8Array> {
  return new Promise((resolveArchive, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("error", reject);
    pack.on("end", () => resolveArchive(gzipSync(Buffer.concat(chunks))));
    for (const entry of files) {
      const content = typeof entry.body === "string" ? Buffer.from(entry.body) : Buffer.from(entry.body ?? new Uint8Array());
      pack.entry({ name: entry.name, size: content.byteLength, mode: 0o644, type: "file", mtime: new Date(0),
        uid: 0, gid: 0, uname: "", gname: "" } as Parameters<typeof pack.entry>[0], content);
    }
    pack.finalize();
  });
}

test("Pi executes a selected verified managed pack, then refuses changed pinned store bytes before cached code", async () => {
  const root = project();
  expect(bounded(root, ["init", "--host", "pi"]).code).toBe(0);
  const source = join(root, "source");
  const clone = Bun.spawnSync(["git", "clone", "--quiet", "--no-hardlinks", REPO, source],
    { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (clone.exitCode !== 0) throw new Error(`Published pack fixture clone failed: ${clone.stderr.toString()}`);
  cpSync(join(REPO, "src"), join(source, "src"), { recursive: true, force: true });
  cpSync(join(REPO, "bun.lock"), join(source, "bun.lock"), { force: true });
  const dependencies = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile", "--offline"],
    { cwd: source, stdout: "pipe", stderr: "pipe" });
  if (dependencies.exitCode !== 0) throw new Error(`Published pack fixture install failed: ${dependencies.stderr.toString()}`);
  const packageRoot = join(source, "src", "published-packs", "example");
  for (const [args, cwd] of [
    [[process.execPath, join(source, "src", "build-published-pack.ts")], packageRoot],
    [[process.execPath, join(source, "src", "dist", "cli.js"), "catalog", "build"], packageRoot],
  ] as const) {
    const built = Bun.spawnSync([...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(`Published pack fixture build failed: ${built.stderr.toString()}`);
  }
  const artifact = await packedArtifact(packageEntries(packageRoot));
  const registry = "https://registry.example.test";
  const tarballUrl = `${registry}/bounded-example/-/bounded-example-0.1.0.tgz`;
  const get = async (url: string) => {
    if (url === `${registry}/bounded-example`) return { status: 200, headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ name: "bounded-example", versions: { "0.1.0": { name: "bounded-example", version: "0.1.0",
        dependencies: {}, peerDependencies: { bounded: "~3.3.0" }, dist: { tarball: tarballUrl, integrity: sha512Integrity(artifact) } } } })) };
    if (url === tarballUrl) return { status: 200, headers: { "content-type": "application/octet-stream" }, body: artifact };
    return { status: 404, headers: {}, body: new TextEncoder().encode("missing") };
  };
  const installed = await runStandaloneAddInternal(["add", "bounded-example@0.1.0", "--registry", registry], {
    projectRoot: root, boundedVersion: archive.version, get,
    env: { ...process.env, XDG_DATA_HOME: archive.dataHome, LOCALAPPDATA: archive.dataHome },
  });
  expect(installed.ok).toBe(true);
  writeFileSync(join(root, "bounded.config.ts"), `import { contribution, defineConfig } from "bounded/domain";
import { refusedToolsPack } from "bounded-example";
export default defineConfig({ packs: [refusedToolsPack],
  contributes: [contribution(refusedToolsPack.points.refusedTools, [{ tool: "web", redirect: "Use local docs" }])] });\n`);
  const storeRoot = join(archive.dataHome, "bounded", "packs", "store");
  const stores = readdirSync(storeRoot);
  expect(stores).toHaveLength(1);
  const storeFile = join(storeRoot, stores[0] ?? "missing", "package", "dist", "packs", "refused-tools", "index.js");
  expect(existsSync(storeFile)).toBe(true);
  const originalStoreBytes = readFileSync(storeFile);
  const result = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const first = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "managed-1", toolName: "web_search", input: { query: "docs" } }, { cwd: process.cwd() });
const fs = await import("node:fs");
fs.appendFileSync(${JSON.stringify(storeFile)}, "\\n// changed after verification\\n");
const second = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "managed-2", toolName: "web_search", input: { query: "docs" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ first, second }));`);
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as { first?: { block?: boolean; reason?: string }; second?: { block?: boolean; reason?: string } };
  expect(answer.first?.block).toBe(true);
  expect(answer.first?.reason).toContain("Use local docs");
  expect(answer.second?.block).toBe(true);
  expect(answer.second?.reason).toMatch(/store|inventory|changed|restart|re.add/i);
  expect(answer.second?.reason).not.toContain("Use local docs");
  writeFileSync(storeFile, originalStoreBytes);
  const projected = join(root, "node_modules", "bounded-example");
  const declaration = readdirSync(projected, { recursive: true }).map(String).find((name) => name.endsWith(".d.ts"));
  expect(declaration).toBeDefined();
  const typeFile = join(projected, declaration ?? "missing");
  const projectedResult = invokeUnderPi(root, `
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
const first = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "types-1", toolName: "web_search", input: { query: "docs" } }, { cwd: process.cwd() });
const fs = await import("node:fs");
fs.appendFileSync(${JSON.stringify(typeFile)}, "\\n// changed projected declaration\\n");
const second = await handlers.get("tool_call")({ type: "tool_call", toolCallId: "types-2", toolName: "web_search", input: { query: "docs" } }, { cwd: process.cwd() });
console.log(JSON.stringify({ first, second }));`);
  expect(projectedResult.code).toBe(0);
  const projectedAnswer = JSON.parse(projectedResult.stdout.trim()) as { first?: { reason?: string }; second?: { block?: boolean; reason?: string } };
  expect(projectedAnswer.first?.reason).toContain("Use local docs");
  expect(projectedAnswer.second?.block).toBe(true);
  expect(projectedAnswer.second?.reason).toMatch(/projection|type|declaration|changed|restart/i);
  expect(projectedAnswer.second?.reason).not.toContain("Use local docs");
}, 240_000);
