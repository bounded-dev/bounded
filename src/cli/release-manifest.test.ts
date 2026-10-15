import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { readReleaseManifest, releaseAssetUrls, selectReleaseTarget, verifyReleaseArchive } from "./release-manifest.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

const executable = bytes("bounded executable for the test");
const releaseJson = bytes('{"version":"3.3.0","target":"linux-arm64-gnu","sourceCommit":"0123456789abcdef","protocolVersion":1}');
const declarations = bytes("export declare const bounded: true;\n");
const archive = bytes("a deterministic stand-in for an archive");
const target = {
  minimumOS: "Linux kernel 3.10, glibc 2.17",
  archive: { name: "bounded-v3.3.0-linux-arm64-gnu.tar.gz", size: archive.byteLength, sha256: sha256(archive) },
  executable: { path: "bin/bounded", size: executable.byteLength, sha256: sha256(executable) },
  files: [
    { path: "release.json", size: releaseJson.byteLength, sha256: sha256(releaseJson) },
    { path: "share/types/index.d.ts", size: declarations.byteLength, sha256: sha256(declarations) },
  ],
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

  test("verifies archive length, digest and every extracted file, rejecting missing or extra entries", () => {
    const parsed = read();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const entries = { "bin/bounded": executable, "release.json": releaseJson, "share/types/index.d.ts": declarations };
    expect(verifyReleaseArchive(parsed.value, "linux-arm64-gnu", archive, entries).ok).toBe(true);
    expect(verifyReleaseArchive(parsed.value, "linux-arm64-gnu", bytes("different archive"), entries).ok).toBe(false);
    expect(verifyReleaseArchive(parsed.value, "linux-arm64-gnu", archive, { ...entries, "share/types/index.d.ts": bytes("changed") }).ok).toBe(false);
    expect(verifyReleaseArchive(parsed.value, "linux-arm64-gnu", archive, { "bin/bounded": executable, "release.json": releaseJson }).ok).toBe(false);
    expect(verifyReleaseArchive(parsed.value, "linux-arm64-gnu", archive, { ...entries, "unexpected.txt": bytes("extra") }).ok).toBe(false);
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
