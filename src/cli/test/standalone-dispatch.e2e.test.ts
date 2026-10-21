import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";
import yazl from "yazl";
import { installerScripts } from "../../release-install-scripts.ts";
import type { ReleaseManifest } from "../release-manifest.ts";

const REPO = resolve(import.meta.dir, "../../..");
const CURRENT = (JSON.parse(readFileSync(join(REPO, "src", "package.json"), "utf8")) as { version: string }).version;
const PINNED = "3.2.9";
const SOURCE_COMMIT = "a".repeat(40);
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const requiredFiles = [
  "LICENSE", "release.json", "share/catalog/bounded.catalog.json", "share/types/index.d.ts",
  "share/claude-code/prereqs-status-band/.claude-plugin/plugin.json",
  "share/claude-code/prereqs-status-band/hooks/engine-subset.ts",
  "share/claude-code/prereqs-status-band/hooks/hooks.json",
  "share/claude-code/prereqs-status-band/hooks/prereqs-status-band-lines.ts",
  "share/claude-code/prereqs-status-band/hooks/prereqs-status-file.ts",
  "share/claude-code/prereqs-status-band/hooks/project-config-names.ts",
  "share/claude-code/prereqs-status-band/hooks/register.ts",
  "share/claude-code/prereqs-status-band/types/index.d.ts",
];

function nativeTarget(): string {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "win32") return `windows-${process.arch}`;
  const ldd = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
  const report = `${ldd.stdout.toString()} ${ldd.stderr.toString()}`.toLowerCase();
  if (report.includes("musl")) return `linux-${process.arch}-musl`;
  if (report.includes("glibc") || report.includes("gnu libc")) return `linux-${process.arch}-gnu`;
  throw new Error("Cannot identify native libc for dispatch test");
}

function compile(source: string, executable: string, options: { readonly withRuntimeAssets?: boolean } = {}): void {
  const standalone = source === join(REPO, "src", "standalone-main.ts") && options.withRuntimeAssets !== false;
  const assets = standalone ? [
    "--asset", join(REPO, "node_modules", "@vscode", "tree-sitter-wasm", "wasm", "tree-sitter.wasm"),
    "--asset", join(REPO, "node_modules", "@vscode", "tree-sitter-wasm", "wasm", "tree-sitter-bash.wasm"),
  ] : [];
  const result = Bun.spawnSync([process.execPath, "build", source, "--compile", ...assets, "--outfile", executable], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  if (process.platform !== "win32") chmodSync(executable, 0o755);
}

async function zipPayload(payloadParent: string, archive: string, version: string, files: readonly string[]): Promise<void> {
  const zip = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolveZip, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolveZip(Buffer.concat(chunks)));
  });
  for (const file of files) zip.addBuffer(readFileSync(join(payloadParent, `bounded-v${version}`, file)), `bounded-v${version}/${file}`, { mode: file.startsWith("bin/") ? 0o100755 : 0o100644 });
  zip.end();
  writeFileSync(archive, await completed);
}

interface Fixture {
  readonly root: string;
  readonly project: string;
  readonly nested: string;
  readonly current: string;
  readonly target: string;
  readonly data: string;
  readonly receiptDirectory: string;
  readonly installed: string;
  readonly manifestBytes: Uint8Array;
  readonly manifestDigest: string;
  readonly script: string;
  readonly env: Record<string, string | undefined>;
}

async function fixture(options: { readonly pinnedStopsWithSignal?: boolean } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "bounded-dispatch-red-"));
  const target = nativeTarget();
  const data = join(root, "user-data");
  const project = join(root, "project with spaces");
  const nested = join(project, "src", "nested");
  const assets = join(root, "assets");
  const fakeBin = join(root, "fake-bin");
  const payloadParent = join(root, "payload");
  const payload = join(payloadParent, `bounded-v${PINNED}`);
  const executableName = process.platform === "win32" ? "bounded.exe" : "bounded";
  const current = join(root, `current-${executableName}`);
  const pinned = join(payload, "bin", executableName);
  for (const dir of [nested, assets, fakeBin, join(root, "home"), join(payload, "bin")]) mkdirSync(dir, { recursive: true });
  compile(join(REPO, "src", "standalone-main.ts"), current);
  const fixtureSource = join(root, "pinned-fixture.ts");
  const pinnedAction = options.pinnedStopsWithSignal
    ? 'process.kill(process.pid, "SIGTERM");'
    : `const input = await Bun.stdin.text(); process.stdout.write(JSON.stringify({ version: "${PINNED}", args, input, dispatchedVersion: process.env.BOUNDED_DISPATCHED_VERSION ?? null }) + "\\n"); process.stderr.write("pinned stderr\\n"); process.exitCode = 37;`;
  writeFileSync(fixtureSource, `const args = process.argv.slice(2); if (args.length === 1 && args[0] === "--version") { console.log("${PINNED}"); } else { ${pinnedAction} }\n`);
  compile(fixtureSource, pinned);
  for (const file of requiredFiles) {
    const path = join(payload, file);
    mkdirSync(dirname(path), { recursive: true });
    let content = `${file}\n`;
    if (file === "release.json") content = `${JSON.stringify({ version: PINNED, target, sourceCommit: SOURCE_COMMIT, protocolVersion: 1 })}\n`;
    if (file === "share/catalog/bounded.catalog.json") {
      const fixtureCatalogue = JSON.parse(readFileSync(join(REPO, "src", "cli", "test", "fixtures", "bounded.catalog.json"), "utf8")) as Record<string, unknown>;
      content = `${JSON.stringify({ ...fixtureCatalogue, package: { name: "bounded", version: PINNED } })}\n`;
    }
    if (file.endsWith(".claude-plugin/plugin.json")) content = `${JSON.stringify({ name: "bounded-prereqs-status-band", version: PINNED, types: "./types/index.d.ts" })}\n`;
    writeFileSync(path, content);
  }
  const archiveName = `bounded-v${PINNED}-${target}.${target.startsWith("linux-") ? "tar.gz" : "zip"}`;
  const archive = join(assets, archiveName);
  if (target.startsWith("linux-")) {
    const tar = Bun.spawnSync(["tar", "-czf", archive, `bounded-v${PINNED}`], { cwd: payloadParent, stdout: "pipe", stderr: "pipe" });
    if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
  } else {
    await zipPayload(payloadParent, archive, PINNED, [`bin/${executableName}`, ...requiredFiles]);
  }
  const fileOf = (path: string) => ({ path, size: readFileSync(join(payload, path)).byteLength, sha256: digest(readFileSync(join(payload, path))) });
  const manifest: ReleaseManifest = {
    schema: "bounded-release/1", version: PINNED, channel: "stable", sourceCommit: SOURCE_COMMIT, builtWith: `Bun ${Bun.version}`,
    targets: {
      [target]: {
        minimumOS: target.startsWith("darwin-") ? "macOS 12" : target.startsWith("windows-") ? "Windows 10 1809" : "Linux",
        archive: { name: archiveName, size: readFileSync(archive).byteLength, sha256: digest(readFileSync(archive)) },
        executable: fileOf(`bin/${executableName}`), files: requiredFiles.map(fileOf).sort((a, b) => a.path.localeCompare(b.path, "en")),
      },
    },
  };
  const manifestBytes = bytes(`${JSON.stringify(manifest)}\n`);
  const manifestDigest = digest(manifestBytes);
  const manifestName = `bounded-v${PINNED}-manifest-v1.json`;
  writeFileSync(join(assets, manifestName), manifestBytes);
  const script = join(root, process.platform === "win32" ? "install.ps1" : "install.sh");
  writeFileSync(script, process.platform === "win32" ? installerScripts(manifest, manifestDigest).windows : installerScripts(manifest, manifestDigest).unix);
  const fakeCurl = join(fakeBin, "curl");
  writeFileSync(fakeCurl, `#!/bin/sh\nset -eu\nprintf '%s\\n' "$*" >> "$CURL_LOG"\nout=''; url=''\nwhile [ "$#" -gt 0 ]; do case "$1" in --output) shift; out="$1" ;; https://*) url="$1" ;; esac; shift; done\ncase "$url" in 'https://github.com/bounded-dev/bounded/releases/download/v${PINNED}/${manifestName}') cp "$ASSETS/${manifestName}" "$out" ;; 'https://github.com/bounded-dev/bounded/releases/download/v${PINNED}/${archiveName}') cp "$ASSETS/${archiveName}" "$out" ;; *) exit 23 ;; esac\n`);
  chmodSync(fakeCurl, 0o755);
  const fakeUname = join(fakeBin, "uname");
  writeFileSync(fakeUname, `#!/bin/sh\ncase "$1" in -s) echo ${process.platform === "darwin" ? "Darwin" : "Linux"} ;; -m) echo ${process.arch === "arm64" ? "arm64" : "x86_64"} ;; esac\n`);
  chmodSync(fakeUname, 0o755);
  const pin = join(project, ".bounded", "version.json");
  mkdirSync(dirname(pin), { recursive: true });
  writeFileSync(pin, `${JSON.stringify({ schema: "bounded-project-version/1", version: PINNED })}\n`);
  return {
    root, project, nested, current, target, data,
    receiptDirectory: join(data, "bounded", "receipts", `v${PINNED}`, target),
    installed: join(data, "bounded", "releases", `v${PINNED}`, target),
    manifestBytes, manifestDigest, script,
    env: { ...process.env, HOME: join(root, "home"), PATH: `${fakeBin}:${process.env.PATH ?? ""}`, XDG_DATA_HOME: data, XDG_BIN_HOME: join(root, "bin"), ASSETS: assets, CURL_LOG: join(root, "curl.log") },
  };
}

function runInstaller(f: Fixture): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["sh", f.script], { env: f.env, stdout: "pipe", stderr: "pipe" });
}

function runCurrent(f: Fixture, args: string[], input = "", options: { cwd?: string; env?: Record<string, string | undefined> } = {}): { exitCode: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync([f.current, ...args], {
    cwd: options.cwd ?? f.nested, env: { ...f.env, PATH: join(f.root, "empty-path"), ...options.env },
    stdin: bytes(input), stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("generated installer records immutable manifest and compiled entry dispatches before CLI or host parsing", async () => {
  const f = await fixture();
  try {
    if (process.platform === "win32") {
      // Native PowerShell installer behavior still needs a Windows CI fixture;
      // this assertion only keeps receipt emission visible on this path.
      expect(readFileSync(f.script, "utf8")).toContain("receipt-v1.json");
      return;
    }
    const installed = runInstaller(f);
    expect(installed.exitCode).toBe(0);
    const receipt = JSON.parse(readFileSync(join(f.receiptDirectory, "receipt-v1.json"), "utf8"));
    expect(receipt).toEqual({ schema: "bounded-install-receipt/1", version: PINNED, target: f.target, manifestSha256: f.manifestDigest });
    expect(readFileSync(join(f.receiptDirectory, "manifests", `${f.manifestDigest}.json`))).toEqual(Buffer.from(f.manifestBytes));
    const normal = runCurrent(f, ["check", "--path", "two words"], "forwarded stdin\n");
    expect(normal.exitCode).toBe(37);
    expect(JSON.parse(normal.stdout)).toEqual({ version: PINNED, args: ["check", "--path", "two words"], input: "forwarded stdin\n", dispatchedVersion: PINNED });
    expect(normal.stderr).toBe("pinned stderr\n");
    for (const args of [["hook", "claude-code"], ["init", "--host", "claude-code"]]) {
      const redirected = runCurrent(f, args, "not a host payload");
      expect(redirected.exitCode).toBe(37);
      expect(JSON.parse(redirected.stdout).args).toEqual(args);
      expect(redirected.stderr).toBe("pinned stderr\n");
    }
    expect(runCurrent(f, ["--version"]).stdout.trim()).toBe(CURRENT);
    expect(runCurrent(f, ["update", "--no-upgrade"]).exitCode).not.toBe(37);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 180_000);

test("a validated one-hop marker is consumed before normal handlers run", async () => {
  const prior = process.env.BOUNDED_DISPATCHED_VERSION;
  try {
    process.env.BOUNDED_DISPATCHED_VERSION = CURRENT;
    const { dispatchStandalone } = await import("../../standalone-dispatch.ts");
    const result = await dispatchStandalone(["--version"], CURRENT);
    expect(result.answered).toBe(false);
    expect(process.env.BOUNDED_DISPATCHED_VERSION).toBeUndefined();
  } finally {
    if (prior === undefined) delete process.env.BOUNDED_DISPATCHED_VERSION;
    else process.env.BOUNDED_DISPATCHED_VERSION = prior;
  }
});

test("a pending update journal blocks a cross-version Pi hook before handoff", async () => {
  const f = await fixture();
  try {
    if (process.platform === "win32") return;
    expect(runInstaller(f).exitCode).toBe(0);
    const journal = join(f.project, ".bounded", "update-journal.json");
    writeFileSync(journal, "pending\n");
    const hook = runCurrent(f, ["hook", "pi", "--project", f.project], "host frame\n");
    expect(hook.exitCode).toBe(2);
    expect(hook.stderr).toMatch(/update-journal\.json|update journal/i);
    expect(hook.stdout).toBe("");
    expect(readFileSync(journal, "utf8")).toBe("pending\n");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 180_000);

test("Claude's explicit unpinned project keeps working after its .bounded log directory appears", async () => {
  const f = await fixture();
  try {
    const unpinned = join(f.root, "existing-host-project");
    mkdirSync(join(unpinned, ".bounded"), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const hook = runCurrent(f, ["hook", "claude-code"], "not JSON", { env: { CLAUDE_PROJECT_DIR: unpinned } });
      expect(hook.exitCode).toBe(0);
      expect(hook.stdout).toContain("not JSON");
      expect(hook.stderr).not.toMatch(/version\.json|pin/i);
    }
    rmSync(join(unpinned, ".bounded"), { recursive: true });
    symlinkSync(join(f.root, "missing-host-boundary"), join(unpinned, ".bounded"), "dir");
    const linked = runCurrent(f, ["hook", "claude-code"], "not JSON", { env: { CLAUDE_PROJECT_DIR: unpinned } });
    expect(linked.exitCode).not.toBe(0);
    expect(linked.stderr).toMatch(/\.bounded|link|project boundary/i);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 180_000);

test("a signalled pinned executable fails closed with an explicit signal diagnostic", async () => {
  const f = await fixture({ pinnedStopsWithSignal: true });
  try {
    if (process.platform === "win32") {
      expect(readFileSync(f.script, "utf8")).toContain("receipt-v1.json");
      return;
    }
    expect(runInstaller(f).exitCode).toBe(0);
    const stopped = runCurrent(f, ["check"]);
    expect(stopped.exitCode).toBe(2);
    expect(stopped.stderr).toMatch(/SIGTERM|signal|terminated/i);
    expect(stopped.stdout).toBe("");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 180_000);

test("a pinned project hands off before the active binary needs its own runtime assets", async () => {
  const f = await fixture();
  try {
    if (process.platform === "win32") {
      expect(readFileSync(f.script, "utf8")).toContain("receipt-v1.json");
      return;
    }
    expect(runInstaller(f).exitCode).toBe(0);
    compile(join(REPO, "src", "standalone-main.ts"), f.current, { withRuntimeAssets: false });
    const handedOff = runCurrent(f, ["hook", "claude-code"], "invalid host payload");
    expect(handedOff.exitCode).toBe(37);
    expect(JSON.parse(handedOff.stdout)).toMatchObject({ version: PINNED, args: ["hook", "claude-code"], input: "invalid host payload" });
    expect(handedOff.stderr).toBe("pinned stderr\n");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 180_000);

test("dispatch refuses every changed installed artifact before invoking the pinned binary", async () => {
  const f = await fixture();
  try {
    if (process.platform === "win32") {
      expect(readFileSync(f.script, "utf8")).toContain("receipt-v1.json");
      return;
    }
    expect(runInstaller(f).exitCode).toBe(0);
    const receipt = join(f.receiptDirectory, "receipt-v1.json");
    const blob = join(f.receiptDirectory, "manifests", `${f.manifestDigest}.json`);
    const binary = join(f.installed, "bin", "bounded");
    const identity = join(f.installed, "release.json");
    const replacementSource = join(f.root, "replacement-fixture.ts");
    const replacementBinary = join(f.root, "replacement-bounded");
    writeFileSync(replacementSource, `if (process.argv[2] === "--version") console.log("${PINNED}"); else console.log("changed executable ran");\n`);
    compile(replacementSource, replacementBinary);
    expect(Bun.spawnSync([replacementBinary, "--version"], { stdout: "pipe" }).stdout.toString().trim()).toBe(PINNED);
    const changes: readonly { name: string; path: string; replacement?: string | Uint8Array; remove?: boolean; linked?: boolean }[] = [
      { name: "runnable changed binary", path: binary, replacement: readFileSync(replacementBinary) },
      { name: "same-identity release.json", path: identity, replacement: `${JSON.stringify({ version: PINNED, target: f.target, sourceCommit: SOURCE_COMMIT, protocolVersion: 1 })}   \n` },
      { name: "manifest", path: blob, replacement: `${new TextDecoder().decode(f.manifestBytes)} ` },
      { name: "receipt digest", path: receipt, replacement: JSON.stringify({ schema: "bounded-install-receipt/1", version: PINNED, target: f.target, manifestSha256: "f".repeat(64) }) },
      { name: "receipt schema", path: receipt, replacement: JSON.stringify({ schema: "wrong", version: PINNED, target: f.target, manifestSha256: f.manifestDigest }) },
      { name: "receipt version", path: receipt, replacement: JSON.stringify({ schema: "bounded-install-receipt/1", version: "3.2.8", target: f.target, manifestSha256: f.manifestDigest }) },
      { name: "receipt target", path: receipt, replacement: JSON.stringify({ schema: "bounded-install-receipt/1", version: PINNED, target: "wrong-target", manifestSha256: f.manifestDigest }) },
      { name: "missing receipt", path: receipt, remove: true },
      { name: "missing binary", path: binary, remove: true },
      { name: "linked release file", path: identity, linked: true },
      { name: "linked receipt", path: receipt, linked: true },
    ];
    for (const change of changes) {
      const original = readFileSync(change.path);
      try {
        rmSync(change.path);
        if (change.linked) {
          const outside = join(f.root, `outside-${change.name.replaceAll(" ", "-")}`);
          writeFileSync(outside, original);
          symlinkSync(outside, change.path);
        } else if (!change.remove) writeFileSync(change.path, change.replacement ?? "");
        if (change.path === binary && !change.remove) chmodSync(binary, 0o755);
        const denied = runCurrent(f, ["check"]);
        expect(denied.exitCode).not.toBe(37);
        expect(denied.stdout).not.toContain(`"version":"${PINNED}"`);
        expect(denied.stderr).toMatch(/install|receipt|manifest|release|SHA|digest|missing|file|target/i);
      } finally {
        rmSync(change.path, { force: true });
        writeFileSync(change.path, original);
        if (change.path === binary) chmodSync(binary, 0o755);
      }
    }
    const extra = join(f.installed, "unexpected-file");
    writeFileSync(extra, "not in the release manifest");
    const denied = runCurrent(f, ["check"]);
    expect(denied.exitCode).not.toBe(37);
    expect(denied.stderr).toMatch(/unexpected|file|release|manifest/i);
    expect(readdirSync(f.installed)).toContain("unexpected-file");
    expect(readFileSync(join(f.root, "curl.log"), "utf8").trim().split("\n")).toHaveLength(2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 180_000);

test("pin root precedence, strict shape, one-hop and standalone refusals fail closed", async () => {
  const f = await fixture();
  try {
    if (process.platform === "win32") {
      expect(readFileSync(f.script, "utf8")).toContain("receipt-v1.json");
      return;
    }
    expect(runInstaller(f).exitCode).toBe(0);
    const pin = join(f.project, ".bounded", "version.json");
    const hook = ["hook", "claude-code"];
    expect(runCurrent(f, hook, "bad payload", { env: { CLAUDE_PROJECT_DIR: f.project } }).exitCode).toBe(37);
    const elsewhere = join(f.root, "elsewhere");
    mkdirSync(join(elsewhere, ".bounded"), { recursive: true });
    writeFileSync(join(elsewhere, ".bounded", "version.json"), JSON.stringify({ schema: "bounded-project-version/1", version: CURRENT }));
    expect(runCurrent(f, [...hook, "--project", f.project], "bad payload", { cwd: elsewhere, env: { CLAUDE_PROJECT_DIR: elsewhere } }).exitCode).toBe(37);
    const explicitArgs = [...hook, "--project", f.project];
    expect(JSON.parse(runCurrent(f, explicitArgs, "bad payload", { cwd: elsewhere }).stdout).args).toEqual(explicitArgs);
    for (const invalidRoot of ["relative", join(f.root, "missing")]) {
      const denied = runCurrent(f, [...hook, "--project", invalidRoot], "bad payload");
      expect(denied.exitCode).not.toBe(37);
      expect(denied.stderr).toMatch(/project|absolute|directory/i);
    }
    for (const invalidClaudeRoot of ["relative", join(f.root, "missing")]) {
      const denied = runCurrent(f, hook, "bad payload", { env: { CLAUDE_PROJECT_DIR: invalidClaudeRoot } });
      expect(denied.exitCode).not.toBe(37);
      expect(denied.stderr).toMatch(/CLAUDE_PROJECT_DIR|project|absolute|directory/i);
    }
    for (const invalid of ['{"version":"3.2.9"}', '{"schema":"bounded-project-version/1","version":"latest"}', '{"schema":"bounded-project-version/1","version":"3.2.9","extra":true}', "not JSON"]) {
      writeFileSync(pin, invalid);
      const denied = runCurrent(f, ["check"]);
      expect(denied.exitCode).not.toBe(37);
      expect(denied.stderr).toMatch(/pin|version\.json|schema/i);
    }
    writeFileSync(pin, JSON.stringify({ schema: "bounded-project-version/1", version: PINNED }));
    const nestedBoundary = join(f.project, "src", ".bounded");
    mkdirSync(nestedBoundary);
    const missingNestedPin = runCurrent(f, ["init"]);
    expect(missingNestedPin.exitCode).not.toBe(37);
    expect(missingNestedPin.stderr).toMatch(/release\.json/i);
    expect(missingNestedPin.stderr).not.toMatch(/package\.json/i);
    writeFileSync(join(nestedBoundary, "version.json"), "malformed");
    expect(runCurrent(f, ["check"]).stderr).toMatch(/pin|version\.json|schema/i);
    writeFileSync(join(nestedBoundary, "version.json"), JSON.stringify({ schema: "bounded-project-version/1", version: PINNED }));
    expect(runCurrent(f, ["check"]).exitCode).toBe(37);
    rmSync(nestedBoundary, { recursive: true });
    symlinkSync(join(f.root, "missing-boundary"), nestedBoundary, "dir");
    const danglingBoundary = runCurrent(f, ["check"]);
    expect(danglingBoundary.exitCode).not.toBe(37);
    expect(danglingBoundary.stderr).toMatch(/\.bounded|link|project boundary/i);
    rmSync(nestedBoundary);
    mkdirSync(nestedBoundary);
    writeFileSync(join(nestedBoundary, "version.json"), JSON.stringify({ schema: "bounded-project-version/1", version: PINNED }));
    const oneHop = runCurrent(f, ["check"], "", { env: { BOUNDED_DISPATCHED_VERSION: "other" } });
    expect(oneHop.exitCode).not.toBe(37);
    expect(oneHop.stderr).toMatch(/dispatch|hop|version|pin/i);
    const unpinnedProject = join(f.root, "no-pin-project");
    mkdirSync(unpinnedProject);
    const noPin = runCurrent(f, ["init"], "", { cwd: unpinnedProject });
    expect(noPin.exitCode).not.toBe(37);
    expect(noPin.stdout).not.toContain(`"version":"${PINNED}"`);
    rmSync(join(f.installed, "bin", "bounded"));
    const missing = runCurrent(f, ["check"]);
    expect(missing.exitCode).not.toBe(37);
    expect(missing.stderr).toMatch(/install|missing|release/i);
    expect(missing.stderr).not.toMatch(/download|fetching/i);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 180_000);

test("installer does not replace a valid receipt with a different manifest or after a failed reinstall", async () => {
  const f = await fixture();
  try {
    if (process.platform === "win32") {
      expect(readFileSync(f.script, "utf8")).toContain("receipt-v1.json");
      return;
    }
    expect(runInstaller(f).exitCode).toBe(0);
    const receipt = join(f.receiptDirectory, "receipt-v1.json");
    const before = readFileSync(receipt);
    expect(runInstaller(f).exitCode).toBe(0);
    expect(readFileSync(receipt)).toEqual(before);
    const manifestPath = join(f.root, "assets", `bounded-v${PINNED}-manifest-v1.json`);
    const secondManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
    const changedManifest = { ...secondManifest, builtWith: `Bun ${Bun.version} second valid build` };
    const changedBytes = bytes(`${JSON.stringify(changedManifest)}\n`);
    expect(digest(changedBytes)).not.toBe(f.manifestDigest);
    writeFileSync(manifestPath, changedBytes);
    writeFileSync(f.script, installerScripts(changedManifest, digest(changedBytes)).unix);
    const changed = runInstaller(f);
    expect(changed.exitCode).not.toBe(0);
    expect(changed.stderr?.toString()).toMatch(/receipt|manifest|digest|version|release/i);
    expect(readFileSync(receipt)).toEqual(before);
    expect(existsSync(join(f.data, "bounded", "active"))).toBe(true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 180_000);

test("failed first installation leaves no usable receipt or active version", async () => {
  const f = await fixture();
  try {
    if (process.platform === "win32") {
      expect(readFileSync(f.script, "utf8")).toContain("receipt-v1.json");
      return;
    }
    const archiveName = `bounded-v${PINNED}-${f.target}.${f.target.startsWith("linux-") ? "tar.gz" : "zip"}`;
    writeFileSync(join(f.root, "assets", archiveName), "damaged archive");
    const failed = runInstaller(f);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr?.toString()).toMatch(/archive|size|SHA-256/i);
    expect(existsSync(join(f.receiptDirectory, "receipt-v1.json"))).toBe(false);
    expect(existsSync(join(f.data, "bounded", "active"))).toBe(false);
    const orphanBlobs = join(f.receiptDirectory, "manifests");
    if (existsSync(orphanBlobs)) expect(readdirSync(orphanBlobs).every((name) => name === `${f.manifestDigest}.json`)).toBe(true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 180_000);
