import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { readReleaseManifest, type ReleaseFile } from "./cli/release-manifest.ts";

type Located = { readonly ok: true; readonly executable: string; readonly releaseRoot: string; readonly manifestSha256: string; readonly verifiedFiles: readonly ReleaseFile[] } | { readonly ok: false; readonly error: string };
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const sha256 = /^[a-f0-9]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function userDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    if (env.LOCALAPPDATA === undefined) throw new Error("LOCALAPPDATA is required to locate installed Bounded releases");
    return join(env.LOCALAPPDATA, "Bounded");
  }
  return join(env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), ".local", "share"), "bounded");
}

export function nativeReleaseTarget(): string {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "win32") return `windows-${process.arch}`;
  if (process.platform !== "linux") throw new Error(`Unsupported native platform ${process.platform}`);
  const ldd = ["/usr/bin/ldd", "/bin/ldd"].find(existsSync);
  if (ldd === undefined) throw new Error("Cannot identify Linux libc: ldd is missing");
  const report = Bun.spawnSync([ldd, "--version"], { stdout: "pipe", stderr: "pipe" });
  const output = `${report.stdout.toString()} ${report.stderr.toString()}`.toLowerCase();
  if (output.includes("musl")) return `linux-${process.arch}-musl`;
  if (output.includes("glibc") || output.includes("gnu libc")) return `linux-${process.arch}-gnu`;
  throw new Error("Cannot identify Linux libc");
}

function noLinkedComponents(root: string, path: string): boolean {
  const suffix = relative(root, path);
  if (suffix.startsWith("..") || suffix.startsWith(sep)) return false;
  let current = root;
  for (const component of suffix.split(sep)) {
    if (component === "") continue;
    current = join(current, component);
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) return false;
  }
  return true;
}

function installedFiles(release: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`installed release contains a linked file: ${relative(release, path)}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(release, path).split(sep).join("/"));
      else throw new Error(`installed release contains a non-file: ${relative(release, path)}`);
    }
  };
  visit(release);
  return files.sort();
}

function verifyFile(release: string, expected: ReleaseFile): string | undefined {
  const path = join(release, expected.path);
  if (!noLinkedComponents(release, path) || !statSync(path).isFile()) return `installed release file ${expected.path} is missing or linked`;
  const content = readFileSync(path);
  if (content.byteLength !== expected.size || digest(content) !== expected.sha256) return `installed release file ${expected.path} fails size or SHA-256 verification`;
  return undefined;
}

function identityOf(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("installed release.json is not valid JSON"); }
}

/** Verify every installed byte against the exact installer-pinned manifest before executing an older release. */
export function locateInstalledRelease(version: string, env: NodeJS.ProcessEnv = process.env): Located {
  if (!exactVersion.test(version)) return { ok: false, error: "project pin has an invalid Bounded version" };
  try {
    const root = userDataRoot(env);
    const targetId = nativeReleaseTarget();
    const receiptDirectory = join(root, "receipts", `v${version}`, targetId);
    const receiptPath = join(receiptDirectory, "receipt-v1.json");
    if (!noLinkedComponents(root, receiptPath)) return { ok: false, error: `Bounded ${version} has no valid installation receipt for ${targetId}; install that version` };
    const rawReceipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (!isRecord(rawReceipt) || Object.keys(rawReceipt).sort().join() !== ["schema", "version", "target", "manifestSha256"].sort().join() || rawReceipt.schema !== "bounded-install-receipt/1" || rawReceipt.version !== version || rawReceipt.target !== targetId || typeof rawReceipt.manifestSha256 !== "string" || !sha256.test(rawReceipt.manifestSha256)) {
      return { ok: false, error: `Bounded ${version} has a malformed installation receipt; reinstall that version` };
    }
    const blobPath = join(receiptDirectory, "manifests", `${rawReceipt.manifestSha256}.json`);
    if (!noLinkedComponents(root, blobPath)) return { ok: false, error: `Bounded ${version} installation manifest is missing or linked; reinstall that version` };
    const manifestBytes = readFileSync(blobPath);
    const parsed = readReleaseManifest(manifestBytes, rawReceipt.manifestSha256, version);
    if (!parsed.ok) return { ok: false, error: `Bounded ${version} installation manifest is invalid: ${parsed.error}; reinstall that version` };
    const target = parsed.value.targets[targetId];
    if (target === undefined) return { ok: false, error: `Bounded ${version} is not installed for native target ${targetId}; install that target` };
    const release = join(root, "releases", `v${version}`, targetId);
    if (!noLinkedComponents(root, release) || !statSync(release).isDirectory()) return { ok: false, error: `Bounded ${version} installed release is missing or linked; reinstall that version` };
    const expectedFiles = [target.executable, ...target.files];
    const actualPaths = installedFiles(release);
    if (actualPaths.join("\0") !== expectedFiles.map((file) => file.path).sort().join("\0")) return { ok: false, error: `Bounded ${version} installed release has missing or unexpected files; reinstall that version` };
    for (const file of expectedFiles) {
      const error = verifyFile(release, file);
      if (error !== undefined) return { ok: false, error: `${error}; reinstall Bounded ${version}` };
    }
    const identity = identityOf(join(release, "release.json"));
    if (!isRecord(identity) || identity.version !== version || identity.target !== targetId || identity.sourceCommit !== parsed.value.sourceCommit || identity.protocolVersion !== 1) {
      return { ok: false, error: `Bounded ${version} release.json does not match the installation manifest; reinstall that version` };
    }
    const executable = join(release, target.executable.path);
    return { ok: true, executable, releaseRoot: release, manifestSha256: rawReceipt.manifestSha256, verifiedFiles: expectedFiles };
  } catch (error) {
    return { ok: false, error: `Cannot verify installed Bounded ${version}: ${error instanceof Error ? error.message : String(error)}. Reinstall that version` };
  }
}
