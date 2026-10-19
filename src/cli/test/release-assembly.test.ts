import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { readReleaseManifest, verifyReleaseArchive } from "../release-manifest.ts";
import * as releaseAssembly from "../../release-assembly.ts";
import { nativeJob, TARGET_IDS, type TargetId } from "./native-release-fixture.test-support.ts";

const REPO = resolve(import.meta.dir, "../../..");
const VERSION = (JSON.parse(readFileSync(join(REPO, "src", "package.json"), "utf8")) as { version: string }).version;
const COMMIT = "0123456789abcdef";
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const fixture = (name: string): Uint8Array => readFileSync(join(REPO, "src", "cli", "test", "fixtures", name));
const EXPECTED_RUN = "https://github.com/bounded-dev/bounded/actions/runs/12345/attempts/2";
const EXPECTED_WORKFLOW = "bounded-dev/bounded/.github/workflows/release.yml";
type VerifiedAttestation = {
  readonly subjectSha256: string;
  readonly repository: string;
  readonly signerWorkflow: string;
  readonly sourceCommit: string;
  readonly sourceRef: string;
  readonly certificate: { readonly runInvocationURI?: string };
  readonly predicate?: { readonly runInvocationURI?: string };
};
type AssemblyVerification = {
  readonly declaredTargetIds: readonly string[];
  readonly expectedRunInvocationURI: string;
  readonly verifyAttestation: (archivePath: string, targetId: string) => Promise<readonly VerifiedAttestation[]>;
};
const assembleVerified = releaseAssembly.assembleRelease as unknown as (inputs: readonly string[], out: string, verification: AssemblyVerification) => Promise<void>;
const verifiedClaim = (digest: string, changes: Partial<VerifiedAttestation> = {}): VerifiedAttestation => ({
  subjectSha256: digest,
  repository: "bounded-dev/bounded",
  signerWorkflow: EXPECTED_WORKFLOW,
  sourceCommit: COMMIT,
  sourceRef: `refs/tags/v${VERSION}`,
  certificate: { runInvocationURI: EXPECTED_RUN },
  ...changes,
});
const outputIsEmpty = (directory: string): boolean => !existsSync(directory) || readdirSync(directory).length === 0;

test("each candidate fixture has a target-specific archive, manifest and smoke record", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-native-fixtures-"));
  try {
    for (const targetId of TARGET_IDS) {
      const input = join(scratch, targetId);
      const { archiveBytes } = await nativeJob(input, targetId, VERSION);
      const manifestBytes = readFileSync(join(input, `bounded-v${VERSION}-manifest-v1.json`));
      const parsed = readReleaseManifest(manifestBytes, sha256(manifestBytes), VERSION);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.error);
      expect((await verifyReleaseArchive(parsed.value, targetId, archiveBytes)).ok).toBe(true);
      expect(existsSync(join(input, `bounded-v${VERSION}-${targetId}-native-smoke-v1.json`))).toBe(true);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

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

test("assembly combines exactly the declared attested native jobs in target order, preserves ZIP bytes and binds installers to the final manifest", async () => {
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
    const verifiedTargets: string[] = [];
    const verification: AssemblyVerification = {
      declaredTargetIds: ["linux-arm64-gnu", "windows-arm64"], expectedRunInvocationURI: EXPECTED_RUN,
      verifyAttestation: async (archivePath, targetId) => {
        verifiedTargets.push(targetId);
        return [verifiedClaim(sha256(readFileSync(archivePath)))];
      },
    };
    await assembleVerified([join(scratch, "windows"), join(scratch, "linux")], first, verification);
    expect(verifiedTargets.sort()).toEqual(["linux-arm64-gnu", "windows-arm64"]);
    await assembleVerified([join(scratch, "linux"), join(scratch, "windows")], second, verification);
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

test("assembly binds the exact nonempty version declaration, rejecting missing and extra targets before output", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-assembly-declaration-"));
  try {
    const linux = join(scratch, "linux");
    const windows = join(scratch, "windows");
    await nativeJob(linux, "linux-arm64-gnu", VERSION);
    await nativeJob(windows, "windows-arm64", VERSION);
    for (const [inputs, declaredTargetIds, reason] of [
      [[linux], [], /declared|empty|target/i],
      [[linux], ["linux-arm64-gnu", "windows-arm64"], /missing|declared.*target/i],
      [[linux, windows], ["linux-arm64-gnu"], /extra|undeclared|target/i],
    ] as const) {
      const out = join(scratch, `out-${declaredTargetIds.length}-${inputs.length}`);
      await expect(assembleVerified(inputs, out, {
        declaredTargetIds, expectedRunInvocationURI: EXPECTED_RUN,
        verifyAttestation: async (archivePath) => [verifiedClaim(sha256(readFileSync(archivePath)))],
      })).rejects.toThrow(reason);
      expect(outputIsEmpty(out)).toBe(true);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("assembly rejects claims with the wrong certificate run, attempt, subject, source or signer", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-assembly-identity-"));
  try {
    const input = join(scratch, "input");
    const { archiveBytes } = await nativeJob(input, "linux-arm64-gnu", VERSION);
    const digest = sha256(archiveBytes);
    const badClaims: readonly [string, VerifiedAttestation][] = [
      ["run", verifiedClaim(digest, { certificate: { runInvocationURI: "https://github.com/bounded-dev/bounded/actions/runs/99999/attempts/2" } })],
      ["attempt", verifiedClaim(digest, { certificate: { runInvocationURI: "https://github.com/bounded-dev/bounded/actions/runs/12345/attempts/1" } })],
      ["missing certificate", verifiedClaim(digest, { certificate: {}, predicate: { runInvocationURI: EXPECTED_RUN } })],
      ["subject", verifiedClaim("0".repeat(64))],
      ["source", verifiedClaim(digest, { sourceCommit: "f".repeat(40) })],
      ["ref", verifiedClaim(digest, { sourceRef: "refs/heads/main" })],
      ["workflow", verifiedClaim(digest, { signerWorkflow: "bounded-dev/bounded/.github/workflows/other.yml" })],
      ["repository", verifiedClaim(digest, { repository: "someone-else/bounded" })],
    ];
    for (const [name, claim] of badClaims) {
      const out = join(scratch, `out-${name.replaceAll(" ", "-")}`);
      await expect(assembleVerified([input], out, {
        declaredTargetIds: ["linux-arm64-gnu"], expectedRunInvocationURI: EXPECTED_RUN,
        verifyAttestation: async () => [claim],
      })).rejects.toThrow(/attestation|provenance|certificate|identity|digest|source|workflow/i);
      expect(outputIsEmpty(out)).toBe(true);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("two structurally valid declared jobs still fail when only one has verified provenance", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-assembly-partial-proof-"));
  try {
    const inputs = [join(scratch, "linux"), join(scratch, "windows")];
    await nativeJob(inputs[0] ?? "", "linux-arm64-gnu", VERSION);
    await nativeJob(inputs[1] ?? "", "windows-arm64", VERSION);
    const out = join(scratch, "out");
    await expect(assembleVerified(inputs, out, {
      declaredTargetIds: ["linux-arm64-gnu", "windows-arm64"], expectedRunInvocationURI: EXPECTED_RUN,
      verifyAttestation: async (archivePath, targetId) => {
        if (targetId === "windows-arm64") throw new Error("no verified attestation for windows-arm64");
        return [verifiedClaim(sha256(readFileSync(archivePath)))];
      },
    })).rejects.toThrow(/attestation|provenance/i);
    expect(outputIsEmpty(out)).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("assembly refuses multiple acceptable verified attestations for one archive", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-assembly-ambiguous-"));
  try {
    const input = join(scratch, "input");
    const { archiveBytes } = await nativeJob(input, "linux-arm64-gnu", VERSION);
    const claim = verifiedClaim(sha256(archiveBytes));
    const out = join(scratch, "out");
    await expect(assembleVerified([input], out, {
      declaredTargetIds: ["linux-arm64-gnu"], expectedRunInvocationURI: EXPECTED_RUN,
      verifyAttestation: async () => [claim, claim],
    })).rejects.toThrow(/ambiguous|multiple|attestation/i);
    expect(outputIsEmpty(out)).toBe(true);
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
    const mixedToolchain = join(scratch, "mixed-toolchain");
    const unsupported = join(scratch, "unsupported");
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
    targetJob(mixedToolchain, "windows-arm64", "stable", { builtWith: "Bun 1.3.15" });
    targetJob(unsupported, "windows-arm64");
    const unsupportedManifestPath = join(unsupported, `bounded-v${VERSION}-manifest-v1.json`);
    const unsupportedManifest = JSON.parse(readFileSync(unsupportedManifestPath, "utf8")) as { targets: Record<string, unknown> };
    unsupportedManifest.targets["windows-riscv64"] = unsupportedManifest.targets["windows-arm64"];
    delete unsupportedManifest.targets["windows-arm64"];
    writeFileSync(unsupportedManifestPath, `${JSON.stringify(unsupportedManifest, null, 2)}\n`);
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
      [[good, mixedToolchain], /identity|toolchain|built.with|mismatch/i],
      [[good, unsupported], /unsupported|target/i],
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

test("assembly refuses an otherwise valid native job backed only by a self-asserted smoke record", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-assembly-untrusted-"));
  try {
    const input = join(scratch, "input");
    targetJob(input, "linux-arm64-gnu");
    expect(existsSync(join(input, `bounded-v${VERSION}-manifest-v1.json`))).toBe(true);
    const output = join(scratch, "output");
    await expect(assembleVerified([input], output, {
      declaredTargetIds: ["linux-arm64-gnu"], expectedRunInvocationURI: EXPECTED_RUN,
      verifyAttestation: async () => { throw new Error("no verified attestation exists for this self-asserted smoke record"); },
    })).rejects.toThrow(/provenance|workflow|attestation|native verification/i);
    expect(outputIsEmpty(output)).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("production assembly refuses a complete declared subset with only self-written smoke records", async () => {
  const declarationPath = join(REPO, "src", "release-targets.json");
  expect(existsSync(declarationPath)).toBe(true);
  if (!existsSync(declarationPath)) return;
  const declaration = JSON.parse(readFileSync(declarationPath, "utf8")) as { version: string; targets: TargetId[] };
  expect(declaration.version).toBe(VERSION);
  expect(declaration.targets.length).toBeGreaterThan(0);
  const scratch = mkdtempSync(join(tmpdir(), "bounded-assembly-self-asserted-"));
  try {
    const inputs: string[] = [];
    for (const targetId of declaration.targets) {
      const input = join(scratch, targetId);
      const job = await nativeJob(input, targetId, VERSION);
      const manifestBytes = readFileSync(join(input, `bounded-v${VERSION}-manifest-v1.json`));
      const manifest = readReleaseManifest(manifestBytes, sha256(manifestBytes), VERSION);
      expect(manifest.ok).toBe(true);
      if (!manifest.ok) throw new Error(manifest.error);
      expect((await verifyReleaseArchive(manifest.value, targetId, job.archiveBytes)).ok).toBe(true);
      inputs.push(input);
    }
    const output = join(scratch, "output");
    const result = assemble(inputs, output);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr?.toString()).toMatch(/provenance|attestation|verified/i);
    expect(outputIsEmpty(output)).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("production assembly refuses missing and extra jobs against its version target declaration", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bounded-assembly-cli-targets-"));
  try {
    const checkout = join(scratch, "checkout");
    const cloned = Bun.spawnSync(["git", "clone", "--local", "--no-hardlinks", "--quiet", REPO, checkout], { stdout: "pipe", stderr: "pipe" });
    expect(cloned.exitCode).toBe(0);
    cpSync(join(REPO, "node_modules"), join(checkout, "node_modules"), { recursive: true });
    writeFileSync(join(checkout, "src", "release-targets.json"), `${JSON.stringify({
      schema: "bounded-release-targets/1", version: VERSION, targets: ["linux-arm64-gnu"],
    })}\n`);
    const declared = join(scratch, "declared");
    const undeclared = join(scratch, "undeclared");
    await nativeJob(declared, "linux-arm64-gnu", VERSION);
    await nativeJob(undeclared, "windows-arm64", VERSION);
    for (const [name, inputs, reason] of [
      ["missing", [undeclared], /missing|declared.*linux-arm64-gnu/i],
      ["extra", [declared, undeclared], /extra|undeclared.*windows-arm64/i],
    ] as const) {
      const out = join(scratch, name);
      const result = Bun.spawnSync([process.execPath, join(checkout, "src", "build-release.ts"), "--assemble", ...inputs.flatMap((input) => ["--input", input]), "--out", out], {
        cwd: checkout, stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr?.toString()).toMatch(reason);
      expect(outputIsEmpty(out)).toBe(true);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
