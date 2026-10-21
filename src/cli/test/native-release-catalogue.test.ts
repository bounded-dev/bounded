import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { readReleaseManifest, verifyReleaseArchive } from "../release-manifest.ts";
import { nativeJob, sha256 } from "./native-release-fixture.test-support.ts";

test("the pinned release requires its bundled catalogue in the manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-release-catalogue-required-"));
  try {
    const { archiveName } = await nativeJob(root, "linux-x64-gnu", "3.3.0");
    const manifestPath = join(root, "bounded-v3.3.0-manifest-v1.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      targets: Record<string, { files: { path: string }[]; archive: { name: string } }> };
    expect(manifest.targets["linux-x64-gnu"]?.archive.name).toBe(archiveName);
    const missing = structuredClone(manifest);
    const target = missing.targets["linux-x64-gnu"];
    if (target === undefined) throw new Error("test target missing");
    target.files = target.files.filter((file) => file.path !== "share/catalog/bounded.catalog.json");
    const missingBytes = new TextEncoder().encode(`${JSON.stringify(missing)}\n`);
    const checked = readReleaseManifest(missingBytes, sha256(missingBytes), "3.3.0");
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error).toContain("share/catalog/bounded.catalog.json");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an extracted archive refuses a catalogue for another package or version, even with matching digests", async () => {
  for (const options of [{ catalogPackage: "other-pack" }, { catalogVersion: "3.3.1" }]) {
    const root = mkdtempSync(join(tmpdir(), "bounded-release-catalogue-identity-"));
    try {
      const { archiveName, archiveBytes } = await nativeJob(root, "linux-x64-gnu", "3.3.0", options);
      const manifestBytes = readFileSync(join(root, "bounded-v3.3.0-manifest-v1.json"));
      const parsed = readReleaseManifest(manifestBytes, sha256(manifestBytes), "3.3.0");
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.targets["linux-x64-gnu"]?.archive.name).toBe(archiveName);
      const verified = await verifyReleaseArchive(parsed.value, "linux-x64-gnu", archiveBytes);
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(verified.error).toMatch(/catalog|version|package/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
