import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { readReleaseManifest, verifyReleaseArchive } from "../release-manifest.ts";

const REPO = resolve(import.meta.dir, "../../..");
const VERSION = (JSON.parse(readFileSync(join(REPO, "src", "package.json"), "utf8")) as { version: string }).version;
const COMMIT = "0123456789abcdef";
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const fixture = (name: string): Uint8Array => readFileSync(join(REPO, "src", "cli", "test", "fixtures", name));

function targetJob(directory: string, targetId: "linux-arm64-gnu" | "windows-arm64", channel = "stable", changes: Record<string, unknown> = {}): { archiveName: string; archiveBytes: Uint8Array } {
  mkdirSync(directory, { recursive: true });
  const archiveBytes = fixture(targetId.startsWith("linux-") ? "valid.tar.gz" : "valid.zip");
  const archiveName = `bounded-v${VERSION}-${targetId}.${targetId.startsWith("linux-") ? "tar.gz" : "zip"}`;
  const releaseJson = bytes(JSON.stringify({ version: VERSION, target: targetId, sourceCommit: COMMIT, protocolVersion: 1 }));
  const pluginManifest = bytes(`{"name": "bounded-prereqs-status-band", "version": "${VERSION}", "types": "./types/index.d.ts"}`);
  const fileBytes: Record<string, Uint8Array> = {
    LICENSE: bytes("MIT test license\n"),
    "release.json": releaseJson,
    "share/types/index.d.ts": bytes("export declare const bounded: true;\n"),
    "share/claude-code/prereqs-status-band/.claude-plugin/plugin.json": pluginManifest,
    "share/claude-code/prereqs-status-band/hooks/hooks.json": bytes('{"hooks":{}}'),
    "share/claude-code/prereqs-status-band/hooks/register.ts": bytes("export {};\n"),
    "share/claude-code/prereqs-status-band/hooks/engine-subset.ts": bytes("export {};\n"),
    "share/claude-code/prereqs-status-band/hooks/prereqs-status-band-lines.ts": bytes("export {};\n"),
    "share/claude-code/prereqs-status-band/hooks/prereqs-status-file.ts": bytes("export {};\n"),
    "share/claude-code/prereqs-status-band/hooks/project-config-names.ts": bytes("export {};\n"),
    "share/claude-code/prereqs-status-band/types/index.d.ts": bytes("export {};\n"),
  };
  const executableBytes = bytes("bounded executable for the test");
  const manifest = {
    schema: "bounded-release/1", version: VERSION, channel, sourceCommit: COMMIT, builtWith: "Bun 1.3.14",
    targets: { [targetId]: {
      minimumOS: targetId.startsWith("linux-") ? "Linux kernel 3.10, glibc 2.17" : "Windows 10 1809",
      archive: { name: archiveName, size: archiveBytes.byteLength, sha256: sha256(archiveBytes) },
      executable: { path: targetId.startsWith("linux-") ? "bin/bounded" : "bin/bounded.exe", size: executableBytes.byteLength, sha256: sha256(executableBytes) },
      files: Object.entries(fileBytes).map(([path, content]) => ({ path, size: content.byteLength, sha256: sha256(content) })).sort((left, right) => left.path.localeCompare(right.path)),
    } },
    ...changes,
  };
  writeFileSync(join(directory, archiveName), archiveBytes);
  writeFileSync(join(directory, `bounded-v${VERSION}-manifest-v1.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, `bounded-v${VERSION}-${targetId}-native-smoke-v1.json`), `${JSON.stringify({
    schema: "bounded-native-smoke/1", version: VERSION, target: targetId, sourceCommit: COMMIT,
    archiveSha256: sha256(archiveBytes), command: "bounded --version", exitCode: 0,
  })}\n`);
  return { archiveName, archiveBytes };
}

function assemble(inputs: readonly string[], out: string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([process.execPath, join(REPO, "src", "build-release.ts"), "--assemble", ...inputs.flatMap((input) => ["--input", input]), "--out", out], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
}

test("assembly combines verified native jobs in target order, preserves ZIP bytes and binds installers to the final manifest", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-assembly-"));
  try {
    const linux = targetJob(join(scratch, "linux"), "linux-arm64-gnu");
    const windows = targetJob(join(scratch, "windows"), "windows-arm64");
    for (const [input, targetId, archiveBytes] of [
      [join(scratch, "linux"), "linux-arm64-gnu", linux.archiveBytes],
      [join(scratch, "windows"), "windows-arm64", windows.archiveBytes],
    ] as const) {
      const inputManifestBytes = readFileSync(join(input, `bounded-v${VERSION}-manifest-v1.json`));
      const inputManifest = readReleaseManifest(inputManifestBytes, sha256(inputManifestBytes), VERSION);
      expect(inputManifest.ok).toBe(true);
      if (!inputManifest.ok) throw new Error(inputManifest.error);
      expect((await verifyReleaseArchive(inputManifest.value, targetId, archiveBytes)).ok).toBe(true);
    }
    const first = join(scratch, "first");
    const second = join(scratch, "second");
    const result = assemble([join(scratch, "windows"), join(scratch, "linux")], first);
    expect(result.exitCode).toBe(0);
    expect(assemble([join(scratch, "linux"), join(scratch, "windows")], second).exitCode).toBe(0);
    const manifestName = `bounded-v${VERSION}-manifest-v1.json`;
    const manifestBytes = readFileSync(join(first, manifestName));
    expect(readFileSync(join(second, manifestName))).toEqual(manifestBytes);
    const parsed = readReleaseManifest(manifestBytes, sha256(manifestBytes), VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.keys(parsed.value.targets)).toEqual(["linux-arm64-gnu", "windows-arm64"]);
    expect(readFileSync(join(first, linux.archiveName))).toEqual(Buffer.from(linux.archiveBytes));
    expect(readFileSync(join(first, windows.archiveName))).toEqual(Buffer.from(windows.archiveBytes));
    expect((await verifyReleaseArchive(parsed.value, "linux-arm64-gnu", readFileSync(join(first, linux.archiveName)))).ok).toBe(true);
    expect((await verifyReleaseArchive(parsed.value, "windows-arm64", readFileSync(join(first, windows.archiveName)))).ok).toBe(true);
    for (const scriptName of ["install.sh", "install.ps1"]) {
      const script = readFileSync(join(first, scriptName), "utf8");
      expect(readFileSync(join(second, scriptName), "utf8")).toBe(script);
      expect(script).toContain(VERSION);
      expect(script).toContain(sha256(manifestBytes));
      expect(script).toContain(`/download/v${VERSION}/`);
      expect(script).not.toContain("/releases/latest/download/");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("assembly refuses duplicate targets, mismatched identities, development artifacts, bad archives, missing smoke records and extraneous inputs", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-assembly-invalid-"));
  try {
    const good = join(scratch, "good");
    const duplicate = join(scratch, "duplicate");
    const development = join(scratch, "development");
    const mismatched = join(scratch, "mismatched");
    const missing = join(scratch, "missing");
    const extra = join(scratch, "extra");
    const corrupt = join(scratch, "corrupt");
    const absent = join(scratch, "absent");
    targetJob(good, "linux-arm64-gnu");
    targetJob(duplicate, "linux-arm64-gnu");
    targetJob(development, "windows-arm64", "development");
    targetJob(mismatched, "windows-arm64", "stable", { sourceCommit: "fedcba9876543210" });
    targetJob(missing, "windows-arm64");
    rmSync(join(missing, `bounded-v${VERSION}-windows-arm64-native-smoke-v1.json`));
    targetJob(extra, "windows-arm64");
    writeFileSync(join(extra, "unlisted.txt"), "unexpected release input");
    const corruptArchive = targetJob(corrupt, "windows-arm64");
    writeFileSync(join(corrupt, corruptArchive.archiveName), "corrupted archive");
    const absentArchive = targetJob(absent, "windows-arm64");
    rmSync(join(absent, absentArchive.archiveName));
    const output = join(scratch, "output");
    for (const [inputs, reason] of [
      [[good, duplicate], /duplicate|already/i],
      [[good, development], /development|stable|channel/i],
      [[good, mismatched], /source.commit|identity|mismatch/i],
      [[good, missing], /smoke/i],
      [[good, extra], /unexpected|extra|unlisted/i],
      [[good, corrupt], /archive|sha-256|digest/i],
      [[good, absent], /missing|archive/i],
    ] as const) {
      const result = assemble(inputs, output);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr?.toString()).toMatch(reason);
      expect(existsSync(join(output, `bounded-v${VERSION}-manifest-v1.json`))).toBe(false);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
