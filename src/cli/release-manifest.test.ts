import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { readReleaseManifest, releaseAssetUrls, selectReleaseTarget, verifyReleaseArchive } from "./release-manifest.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const fixture = (name: string): Uint8Array => readFileSync(join(import.meta.dir, "test", "fixtures", name));

const executable = bytes("bounded executable for the test");
const releaseJson = bytes('{"version":"3.3.0","target":"linux-arm64-gnu","sourceCommit":"0123456789abcdef","protocolVersion":1}');
const declarations = bytes("export declare const bounded: true;\n");
const archive = fixture("valid.tar.gz");
const requiredFiles = {
  LICENSE: bytes("MIT test license\n"),
  "release.json": releaseJson,
  "share/catalog/bounded.catalog.json": fixture("bounded.catalog.json"),
  "share/types/index.d.ts": declarations,
  "share/claude-code/prereqs-status-band/.claude-plugin/plugin.json": bytes('{"name": "bounded-prereqs-status-band", "version": "3.3.0", "types": "./types/index.d.ts"}'),
  "share/claude-code/prereqs-status-band/hooks/hooks.json": bytes('{"hooks":{}}'),
  "share/claude-code/prereqs-status-band/hooks/register.ts": bytes("export {};\n"),
  "share/claude-code/prereqs-status-band/hooks/engine-subset.ts": bytes("export {};\n"),
  "share/claude-code/prereqs-status-band/hooks/prereqs-status-band-lines.ts": bytes("export {};\n"),
  "share/claude-code/prereqs-status-band/hooks/prereqs-status-file.ts": bytes("export {};\n"),
  "share/claude-code/prereqs-status-band/hooks/project-config-names.ts": bytes("export {};\n"),
  "share/claude-code/prereqs-status-band/types/index.d.ts": bytes("export {};\n"),
};
const files = Object.entries(requiredFiles).map(([path, contents]) => ({ path, size: contents.byteLength, sha256: sha256(contents) })).sort((a, b) => a.path.localeCompare(b.path, "en"));
const target = {
  minimumOS: "Linux kernel 3.10, glibc 2.17",
  archive: { name: "bounded-v3.3.0-linux-arm64-gnu.tar.gz", size: archive.byteLength, sha256: sha256(archive) },
  executable: { path: "bin/bounded", size: executable.byteLength, sha256: sha256(executable) },
  files,
};
const manifest = {
  schema: "bounded-release/1",
  version: "3.3.0",
  channel: "stable",
  sourceCommit: "0123456789abcdef",
  builtWith: "Bun 1.3.14",
  targets: { "linux-arm64-gnu": target },
};
const manifestBytes = (value: unknown = manifest): Uint8Array => bytes(JSON.stringify(value));
const read = (value: unknown = manifest, expectedDigest = sha256(manifestBytes(value)), pinnedVersion = "3.3.0") =>
  readReleaseManifest(manifestBytes(value), expectedDigest, pinnedVersion);

describe("standalone release manifest", () => {
  test("accepts an exact pinned manifest and refuses altered bytes, version and schema", () => {
    expect(read().ok).toBe(true);
    expect(read({ ...manifest, sourceCommit: "changed" }, sha256(manifestBytes())).ok).toBe(false);
    expect(read(manifest, sha256(manifestBytes()), "3.3.1").ok).toBe(false);
    expect(read({ ...manifest, schema: "bounded-release/2" }).ok).toBe(false);
  });

  test("refuses duplicate, unsorted, escaping and absolute paths before extracting any file", () => {
    const duplicate = { ...manifest, targets: { "linux-arm64-gnu": { ...target, files: [target.files[0], target.files[0]] } } };
    const unsorted = { ...manifest, targets: { "linux-arm64-gnu": { ...target, files: [...target.files].reverse() } } };
    const escaping = { ...manifest, targets: { "linux-arm64-gnu": { ...target, files: [{ ...target.files[0], path: "../release.json" }] } } };
    const absolute = { ...manifest, targets: { "linux-arm64-gnu": { ...target, executable: { ...target.executable, path: "/bin/bounded" } } } };
    expect(read(duplicate).ok).toBe(false);
    expect(read(unsorted).ok).toBe(false);
    expect(read(escaping).ok).toBe(false);
    expect(read(absolute).ok).toBe(false);
  });

  test("selects only an exact declared OS, architecture and libc target", () => {
    const parsed = read();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(selectReleaseTarget(parsed.value, { platform: "linux", arch: "arm64", libc: "gnu" })).toEqual({ ok: true, value: { id: "linux-arm64-gnu", ...target } });
    expect(selectReleaseTarget(parsed.value, { platform: "linux", arch: "arm64", libc: "musl" }).ok).toBe(false);
    expect(selectReleaseTarget(parsed.value, { platform: "linux", arch: "arm64", libc: "unknown" }).ok).toBe(false);
    expect(selectReleaseTarget(parsed.value, { platform: "linux", arch: "x64", libc: "gnu" }).ok).toBe(false);
    expect(selectReleaseTarget(parsed.value, { platform: "darwin", arch: "arm64" }).ok).toBe(false);
  });

  test("parses verified tar.gz bytes, refusing unexpected members, links and traversal", async () => {
    const parsed = read();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((await verifyReleaseArchive(parsed.value, "linux-arm64-gnu", archive)).ok).toBe(true);
    expect((await verifyReleaseArchive(parsed.value, "linux-arm64-gnu", bytes("different archive"))).ok).toBe(false);
    const sameLengthTamperedArchive = Uint8Array.from(archive);
    sameLengthTamperedArchive[0] = (sameLengthTamperedArchive[0] ?? 0) ^ 1;
    expect((await verifyReleaseArchive(parsed.value, "linux-arm64-gnu", sameLengthTamperedArchive)).ok).toBe(false);
    for (const name of ["extra.tar.gz", "symlink.tar.gz", "hardlink.tar.gz", "traversal.tar.gz"]) {
      const content = fixture(name);
      const candidate = { ...manifest, targets: { "linux-arm64-gnu": { ...target, archive: { ...target.archive, size: content.byteLength, sha256: sha256(content) } } } };
      const readCandidate = read(candidate);
      expect(readCandidate.ok).toBe(true);
      if (!readCandidate.ok) continue;
      expect((await verifyReleaseArchive(readCandidate.value, "linux-arm64-gnu", content)).ok).toBe(false);
    }
  });

  test("parses verified ZIP bytes, refusing links and traversal", async () => {
    const windowsReleaseJson = bytes('{"version":"3.3.0","target":"windows-arm64","sourceCommit":"0123456789abcdef","protocolVersion":1}');
    const windowsFiles = files.map((file) => file.path === "release.json" ? { ...file, size: windowsReleaseJson.byteLength, sha256: sha256(windowsReleaseJson) } : file);
    for (const name of ["valid.zip", "symlink.zip", "traversal.zip"]) {
      const content = fixture(name);
      const windowsTarget = {
        ...target,
        archive: { name: "bounded-v3.3.0-windows-arm64.zip", size: content.byteLength, sha256: sha256(content) },
        executable: { ...target.executable, path: "bin/bounded.exe" },
        files: windowsFiles,
      };
      const readCandidate = read({ ...manifest, targets: { "windows-arm64": windowsTarget } });
      expect(readCandidate.ok).toBe(true);
      if (!readCandidate.ok) continue;
      expect((await verifyReleaseArchive(readCandidate.value, "windows-arm64", content)).ok).toBe(name === "valid.zip");
    }
  });

  test("requires the license, catalogue, declarations and Claude plugin's loadable files", () => {
    for (const missingPath of ["LICENSE", "share/catalog/bounded.catalog.json", "share/types/index.d.ts", "share/claude-code/prereqs-status-band/.claude-plugin/plugin.json", "share/claude-code/prereqs-status-band/hooks/hooks.json", "share/claude-code/prereqs-status-band/hooks/register.ts", "share/claude-code/prereqs-status-band/hooks/engine-subset.ts", "share/claude-code/prereqs-status-band/hooks/prereqs-status-band-lines.ts", "share/claude-code/prereqs-status-band/hooks/prereqs-status-file.ts", "share/claude-code/prereqs-status-band/hooks/project-config-names.ts", "share/claude-code/prereqs-status-band/types/index.d.ts"]) {
      const candidate = { ...manifest, targets: { "linux-arm64-gnu": { ...target, files: files.filter((file) => file.path !== missingPath) } } };
      expect(read(candidate).ok).toBe(false);
    }
  });

  test("rejects Windows case aliases, reserved names and trailing-dot path segments", () => {
    for (const path of ["license", "share/types/INDEX.D.TS", "share/CON/readme", "share/types/aux.txt", "share/types/name.", "share/types/name "]) {
      const candidate = { ...manifest, targets: { "linux-arm64-gnu": { ...target, files: [...files, { path, size: 1, sha256: sha256(bytes("x")) }].sort((a, b) => a.path.localeCompare(b.path, "en")) } } };
      expect(read(candidate).ok).toBe(false);
    }
  });

  test("binds downloads to the script's embedded version and never follows latest for manifest or archive", () => {
    const parsed = read();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const urls = releaseAssetUrls("https://github.com/bounded-dev/bounded/releases", parsed.value, "3.3.0", "linux-arm64-gnu");
    expect(urls).toEqual({
      ok: true,
      value: {
        manifest: "https://github.com/bounded-dev/bounded/releases/download/v3.3.0/bounded-v3.3.0-manifest-v1.json",
        archive: "https://github.com/bounded-dev/bounded/releases/download/v3.3.0/bounded-v3.3.0-linux-arm64-gnu.tar.gz",
      },
    });
    expect(releaseAssetUrls("https://github.com/bounded-dev/bounded/releases", parsed.value, "3.3.1", "linux-arm64-gnu").ok).toBe(false);
    expect(releaseAssetUrls("http://github.com/bounded-dev/bounded/releases", parsed.value, "3.3.0", "linux-arm64-gnu").ok).toBe(false);
  });
});
