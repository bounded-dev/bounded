import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a native standalone archive contains a verified, self-running Bounded executable", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-release-e2e-"));
  try {
    const targetId = nativeTarget();
    const built = Bun.spawnSync([process.execPath, join(REPO, "src", "build-release.ts"), "--target", targetId, "--out", scratch], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(built.exitCode).toBe(0);

    const manifestPath = join(scratch, `bounded-v${VERSION}-manifest-v1.json`);
    expect(existsSync(manifestPath)).toBe(true);
    const manifestBytes = readFileSync(manifestPath);
    const parsed = readReleaseManifest(manifestBytes, sha256(manifestBytes), VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.keys(parsed.value.targets)).toEqual([targetId]);
    const target = parsed.value.targets[targetId];
    expect(target).toBeDefined();
    if (target === undefined) throw new Error(`missing native target ${targetId}`);
    const archiveBytes = readFileSync(join(scratch, target.archive.name));
    const verified = await verifyReleaseArchive(parsed.value, targetId, archiveBytes);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.error);
    const expectedMembers = [target.executable.path, ...target.files.map((file) => file.path)].sort();
    expect(Object.keys(verified.value).sort()).toEqual(expectedMembers);
    expect(verified.value["share/types/index.d.ts"]?.byteLength).toBeGreaterThan(0);
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
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
