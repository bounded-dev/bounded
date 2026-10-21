import { createHash } from "node:crypto";
import { PackageCatalog, type Result } from "bounded/domain";
import { readReleaseArchive, safeReleasePath } from "./release-archive.ts";

export interface ReleaseFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ReleaseArchive {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ReleaseTarget {
  readonly minimumOS: string;
  readonly archive: ReleaseArchive;
  readonly executable: ReleaseFile;
  readonly files: readonly ReleaseFile[];
}

export interface ReleaseManifest {
  readonly schema: "bounded-release/1";
  readonly version: string;
  readonly channel: "stable";
  readonly sourceCommit: string;
  readonly builtWith: string;
  readonly targets: Readonly<Record<string, ReleaseTarget>>;
}

export interface SelectedReleaseTarget extends ReleaseTarget {
  readonly id: string;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isVersion = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value);
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isSize = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validFile = (value: unknown): value is ReleaseFile => isRecord(value) && safeReleasePath(value.path) && isSize(value.size) && isDigest(value.sha256);
const REQUIRED_FILES = [
  "LICENSE",
  "release.json",
  "share/catalog/bounded.catalog.json",
  "share/types/index.d.ts",
  "share/claude-code/prereqs-status-band/.claude-plugin/plugin.json",
  "share/claude-code/prereqs-status-band/hooks/engine-subset.ts",
  "share/claude-code/prereqs-status-band/hooks/hooks.json",
  "share/claude-code/prereqs-status-band/hooks/prereqs-status-band-lines.ts",
  "share/claude-code/prereqs-status-band/hooks/prereqs-status-file.ts",
  "share/claude-code/prereqs-status-band/hooks/project-config-names.ts",
  "share/claude-code/prereqs-status-band/hooks/register.ts",
  "share/claude-code/prereqs-status-band/types/index.d.ts",
] as const;
const targetIds = new Set([
  "darwin-x64", "darwin-arm64", "linux-x64-gnu", "linux-arm64-gnu",
  "linux-x64-musl", "linux-arm64-musl", "windows-x64", "windows-arm64",
]);

function parseReleaseManifest(value: unknown, pinnedVersion: string): Result<ReleaseManifest> {
  if (!isRecord(value) || value.schema !== "bounded-release/1") return { ok: false, error: "unsupported Bounded release manifest schema" };
  if (!isVersion(value.version) || value.version !== pinnedVersion) return { ok: false, error: `release manifest version does not match pinned version ${pinnedVersion}` };
  if (value.channel !== "stable" || typeof value.sourceCommit !== "string" || !/^[a-f0-9]{16,40}$/.test(value.sourceCommit) || typeof value.builtWith !== "string" || !/^Bun \d+\.\d+\.\d+/.test(value.builtWith)) {
    return { ok: false, error: "release manifest identity is malformed" };
  }
  if (!isRecord(value.targets) || Object.keys(value.targets).length === 0) return { ok: false, error: "release manifest declares no targets" };
  const targets: Record<string, ReleaseTarget> = {};
  for (const [targetId, rawTarget] of Object.entries(value.targets)) {
    if (!targetIds.has(targetId) || !isRecord(rawTarget) || typeof rawTarget.minimumOS !== "string" || rawTarget.minimumOS.trim().length === 0) {
      return { ok: false, error: `release target ${targetId} is unsupported or malformed` };
    }
    const expectedArchiveName = `bounded-v${value.version}-${targetId}.${targetId.startsWith("linux-") ? "tar.gz" : "zip"}`;
    const rawArchive = rawTarget.archive;
    if (!isRecord(rawArchive) || rawArchive.name !== expectedArchiveName || !isSize(rawArchive.size) || !isDigest(rawArchive.sha256)) {
      return { ok: false, error: `release target ${targetId} has an invalid archive` };
    }
    const executable = rawTarget.executable;
    if (!validFile(executable) || executable.path !== (targetId.startsWith("windows-") ? "bin/bounded.exe" : "bin/bounded")) {
      return { ok: false, error: `release target ${targetId} has an invalid executable` };
    }
    if (!Array.isArray(rawTarget.files) || !rawTarget.files.every(validFile)) return { ok: false, error: `release target ${targetId} has an invalid file list` };
    const files: ReleaseFile[] = rawTarget.files;
    const filePaths = files.map((file) => file.path);
    if (filePaths.join("\0") !== [...filePaths].sort().join("\0") || new Set(filePaths.map((path) => path.toLowerCase())).size !== filePaths.length || filePaths.some((path) => path.toLowerCase() === executable.path.toLowerCase())) {
      return { ok: false, error: `release target ${targetId} has duplicate or unsorted file paths` };
    }
    for (const requiredPath of REQUIRED_FILES) {
      if (!filePaths.includes(requiredPath)) return { ok: false, error: `release target ${targetId} lacks ${requiredPath}` };
    }
    targets[targetId] = {
      minimumOS: rawTarget.minimumOS,
      archive: { name: rawArchive.name, size: rawArchive.size, sha256: rawArchive.sha256 },
      executable,
      files,
    };
  }
  return { ok: true, value: { schema: "bounded-release/1", version: value.version, channel: "stable", sourceCommit: value.sourceCommit, builtWith: value.builtWith, targets } };
}

/** Verifies the script-pinned manifest digest before parsing any untrusted fields. */
export function readReleaseManifest(bytes: Uint8Array, expectedDigest: string, pinnedVersion: string): Result<ReleaseManifest> {
  if (!isDigest(expectedDigest) || sha256(bytes) !== expectedDigest) return { ok: false, error: "release manifest SHA-256 does not match installer pin" };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, error: "release manifest is not valid UTF-8 JSON" };
  }
  return parseReleaseManifest(value, pinnedVersion);
}

/** Exact target selection; unknown Linux libc is never guessed. */
export function selectReleaseTarget(manifest: ReleaseManifest, host: { readonly platform: string; readonly arch: string; readonly libc?: string }): Result<SelectedReleaseTarget> {
  const targetId = host.platform === "linux" ? `linux-${host.arch}-${host.libc ?? "unknown"}` : `${host.platform}-${host.arch}`;
  const target = manifest.targets[targetId];
  return target === undefined ? { ok: false, error: `release ${manifest.version} does not support target ${targetId}` } : { ok: true, value: { id: targetId, ...target } };
}

/** Checks the compressed bytes and the exhaustive extracted regular-file map before installation. */
export async function verifyReleaseArchive(manifest: ReleaseManifest, targetId: string, archiveBytes: Uint8Array): Promise<Result<Readonly<Record<string, Uint8Array>>>> {
  const target = manifest.targets[targetId];
  if (target === undefined) return { ok: false, error: `release ${manifest.version} does not declare target ${targetId}` };
  if (archiveBytes.byteLength !== target.archive.size || sha256(archiveBytes) !== target.archive.sha256) return { ok: false, error: `release archive ${target.archive.name} fails size or SHA-256 verification` };
  const expectedFiles = [target.executable, ...target.files];
  const parsed = await readReleaseArchive(archiveBytes, target.archive.name, manifest.version, expectedFiles);
  if (!parsed.ok) return parsed;
  const releaseJson = parsed.value["release.json"];
  if (releaseJson === undefined) return { ok: false, error: "release archive lacks release.json" };
  try {
    const identity: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(releaseJson));
    if (!isRecord(identity) || identity.version !== manifest.version || identity.target !== targetId || identity.sourceCommit !== manifest.sourceCommit || identity.protocolVersion !== 1) {
      return { ok: false, error: "release.json does not match the release manifest" };
    }
  } catch {
    return { ok: false, error: "release.json is not valid UTF-8 JSON" };
  }
  const catalogueBytes = parsed.value["share/catalog/bounded.catalog.json"];
  if (catalogueBytes === undefined) return { ok: false, error: "release archive lacks share/catalog/bounded.catalog.json" };
  try {
    const catalogue = PackageCatalog.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(catalogueBytes)));
    if (!catalogue.ok) return { ok: false, error: `release catalogue is invalid: ${catalogue.error}` };
    if (catalogue.value.package.name !== "bounded" || catalogue.value.package.version !== manifest.version)
      return { ok: false, error: `release catalogue package/version does not match bounded@${manifest.version}` };
  } catch {
    return { ok: false, error: "release catalogue is not valid UTF-8 JSON" };
  }
  const pluginManifestBytes = parsed.value["share/claude-code/prereqs-status-band/.claude-plugin/plugin.json"];
  if (pluginManifestBytes === undefined) return { ok: false, error: "release archive lacks the Claude plugin manifest" };
  try {
    const pluginManifest: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pluginManifestBytes));
    if (!isRecord(pluginManifest) || pluginManifest.name !== "bounded-prereqs-status-band" || pluginManifest.version !== manifest.version || pluginManifest.types !== "./types/index.d.ts") {
      return { ok: false, error: "Claude plugin manifest does not match the release" };
    }
  } catch {
    return { ok: false, error: "Claude plugin manifest is not valid UTF-8 JSON" };
  }
  return parsed;
}

/** Constructs URLs only for the script's exact pinned release. */
export function releaseAssetUrls(baseUrl: string, manifest: ReleaseManifest, pinnedVersion: string, targetId: string): Result<{ readonly manifest: string; readonly archive: string }> {
  if (manifest.version !== pinnedVersion || !isVersion(pinnedVersion)) return { ok: false, error: "manifest version does not match installer pin" };
  const target = manifest.targets[targetId];
  if (target === undefined) return { ok: false, error: `release ${pinnedVersion} does not declare target ${targetId}` };
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { ok: false, error: "release base URL is invalid" };
  }
  if (base.protocol !== "https:" || base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") return { ok: false, error: "release base URL must be HTTPS without credentials or query" };
  const releaseBase = `${base.toString().replace(/\/$/, "")}/download/v${pinnedVersion}`;
  return { ok: true, value: { manifest: `${releaseBase}/bounded-v${pinnedVersion}-manifest-v1.json`, archive: `${releaseBase}/${target.archive.name}` } };
}
