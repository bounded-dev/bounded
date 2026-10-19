import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { readReleaseManifest, verifyReleaseArchive } from "../release-manifest.ts";

const REPO = resolve(import.meta.dir, "../../..");
const VERSION = (JSON.parse(readFileSync(join(REPO, "src", "package.json"), "utf8")) as { version: string }).version;
const nativeTarget = (): string => {
  const specified = process.env.BOUNDED_NATIVE_TARGET;
  if (specified !== undefined) return specified;
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "win32") return `windows-${process.arch}`;
  if (process.platform === "linux") {
    const ldd = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
    const description = `${ldd.stdout.toString()}\n${ldd.stderr.toString()}`.toLowerCase();
    if (description.includes("musl")) return `linux-${process.arch}-musl`;
    if (description.includes("glibc") || description.includes("gnu libc")) return `linux-${process.arch}-gnu`;
    throw new Error("Cannot identify Linux libc for the native release smoke test; set BOUNDED_NATIVE_TARGET");
  }
  throw new Error(`No standalone release target for ${process.platform}`);
};
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

test("a native smoke archive contains a verified, self-running Bounded executable and is not a stable release", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-release-e2e-"));
  const staleDeclaration = join(REPO, "src", "dist", "types", "stale-release-marker.d.ts");
  const dirtyProbe = join(REPO, "src", ".release-dirty-probe.txt");
  try {
    writeFileSync(dirtyProbe, "an uncommitted source file must not enter a stable release\n");
    const dirtyRelease = Bun.spawnSync([process.execPath, join(REPO, "src", "build-release.ts"), "--target", nativeTarget(), "--out", join(scratch, "dirty")], {
      cwd: REPO, stdout: "pipe", stderr: "pipe",
    });
    expect(dirtyRelease.exitCode).not.toBe(0);
    expect(dirtyRelease.stderr.toString()).toMatch(/dirty|clean|uncommitted/i);
    expect(existsSync(join(scratch, "dirty", `bounded-v${VERSION}-manifest-v1.json`))).toBe(false);
    rmSync(dirtyProbe);
    writeFileSync(staleDeclaration, "export declare const staleReleaseMarker: true;\n");
    const targetId = nativeTarget();
    const built = Bun.spawnSync([process.execPath, join(REPO, "src", "build-release.ts"), "--target", targetId, "--smoke", "--out", scratch], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(built.exitCode).toBe(0);

    const manifestPath = join(scratch, `bounded-v${VERSION}-manifest-v1.json`);
    expect(existsSync(manifestPath)).toBe(true);
    const manifestBytes = readFileSync(manifestPath);
    const smokeManifest = JSON.parse(manifestBytes.toString()) as { channel: string; targets: Record<string, { archive: { name: string }; executable: { path: string }; files: { path: string }[] }> };
    expect(smokeManifest.channel).toBe("development");
    expect(readReleaseManifest(manifestBytes, sha256(manifestBytes), VERSION).ok).toBe(false);
    expect(Object.keys(smokeManifest.targets)).toEqual([targetId]);
    const target = smokeManifest.targets[targetId];
    expect(target).toBeDefined();
    if (target === undefined) throw new Error(`missing native target ${targetId}`);
    const archiveBytes = readFileSync(join(scratch, target.archive.name));
    const verified = await verifyReleaseArchive(smokeManifest as unknown as Parameters<typeof verifyReleaseArchive>[0], targetId, archiveBytes);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.error);
    const expectedMembers = [target.executable.path, ...target.files.map((file) => file.path)].sort();
    expect(Object.keys(verified.value).sort()).toEqual(expectedMembers);
    expect(verified.value["share/types/index.d.ts"]?.byteLength).toBeGreaterThan(0);
    expect(verified.value["share/types/stale-release-marker.d.ts"]).toBeUndefined();
    expect(verified.value["share/claude-code/prereqs-status-band/hooks/register.ts"]?.byteLength).toBeGreaterThan(0);

    const executable = join(scratch, targetId.startsWith("windows-") ? "bounded.exe" : "bounded");
    const verifiedExecutable = verified.value[target.executable.path];
    expect(verifiedExecutable).toBeDefined();
    if (verifiedExecutable === undefined) throw new Error("verified archive has no executable");
    writeFileSync(executable, verifiedExecutable);
    if (!targetId.startsWith("windows-")) chmodSync(executable, 0o755);
    expect(existsSync(executable)).toBe(true);
    const noRuntimesOnPath = { ...process.env, PATH: join(scratch, "empty-bin") };
    const version = Bun.spawnSync([executable, "--version"], { cwd: scratch, env: noRuntimesOnPath, stdout: "pipe", stderr: "pipe" });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString()).toContain(VERSION);

    const hook = Bun.spawnSync([executable, "hook", "claude-code"], {
      cwd: scratch,
      env: noRuntimesOnPath,
      stdin: new TextEncoder().encode("{not json"),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(hook.exitCode).toBe(0);
    const decision = JSON.parse(hook.stdout.toString()) as { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string } };
    expect(decision.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toContain("not JSON");

    const secondOutput = join(scratch, "repeat");
    const repeated = Bun.spawnSync([process.execPath, join(REPO, "src", "build-release.ts"), "--target", targetId, "--smoke", "--out", secondOutput], {
      cwd: REPO, stdout: "pipe", stderr: "pipe",
    });
    expect(repeated.exitCode).toBe(0);
    expect(readFileSync(join(secondOutput, target.archive.name))).toEqual(archiveBytes);
    expect(readFileSync(join(secondOutput, `bounded-v${VERSION}-manifest-v1.json`))).toEqual(manifestBytes);
  } finally {
    rmSync(dirtyProbe, { force: true });
    rmSync(staleDeclaration, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);

test("stable release builds reject targets that do not match the native host", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-native-target-"));
  try {
    const checkout = join(scratch, "checkout");
    const cloned = Bun.spawnSync(["git", "clone", "--local", "--no-hardlinks", "--quiet", REPO, checkout], { stdout: "pipe", stderr: "pipe" });
    expect(cloned.exitCode).toBe(0);
    cpSync(join(REPO, "node_modules"), join(checkout, "node_modules"), { recursive: true });
    expect(existsSync(join(checkout, "node_modules", "bounded"))).toBe(true);
    const otherArch = process.arch === "arm64" ? "x64" : "arm64";
    const targets = [
      process.platform === "darwin" ? `windows-${otherArch}` : `darwin-${otherArch}`,
      process.platform === "linux"
        ? `linux-${otherArch}-${nativeTarget().endsWith("-gnu") ? "musl" : "gnu"}`
        : `${process.platform === "win32" ? "windows" : "darwin"}-${otherArch}`,
      ...(process.platform === "linux" ? [`linux-${process.arch}-${nativeTarget().endsWith("-gnu") ? "musl" : "gnu"}`] : []),
    ];
    for (const [index, target] of targets.entries()) {
      const output = join(scratch, `output-${index}`);
      const built = Bun.spawnSync([process.execPath, join(checkout, "src", "build-release.ts"), "--target", target, "--out", output], {
        cwd: checkout, env: { ...process.env, BOUNDED_NATIVE_TARGET: target }, stdout: "pipe", stderr: "pipe",
      });
      expect(built.exitCode).not.toBe(0);
      expect(built.stderr.toString()).toMatch(/target.*(does not match|incompatible).*host|host.*(does not match|incompatible).*target/i);
      expect(existsSync(output)).toBe(false);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);
