import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readReleaseManifest, verifyReleaseArchive, type ReleaseManifest, type ReleaseTarget } from "./cli/release-manifest.ts";
import { installerScripts } from "./release-install-scripts.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const targetIds = [
  "darwin-arm64", "darwin-x64", "linux-arm64-gnu", "linux-arm64-musl",
  "linux-x64-gnu", "linux-x64-musl", "windows-arm64", "windows-x64",
];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

interface Job {
  readonly targetId: string;
  readonly target: ReleaseTarget;
  readonly manifest: ReleaseManifest;
  readonly archivePath: string;
}

async function readJob(directory: string): Promise<Job> {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) throw new Error(`release input is not a directory: ${directory}`);
  const names = readdirSync(directory).sort();
  const manifestName = names.find((name) => /^bounded-v[^/]+-manifest-v1\.json$/.test(name));
  if (manifestName === undefined) throw new Error(`release input has no manifest: ${directory}`);
  const version = /^bounded-v(.+)-manifest-v1\.json$/.exec(manifestName)?.[1];
  if (version === undefined) throw new Error("release manifest filename is invalid");
  const manifestBytes = readFileSync(join(directory, manifestName));
  if (manifestBytes.toString().includes('"channel": "development"')) throw new Error("development channel cannot be assembled into a stable release");
  const parsed = readReleaseManifest(manifestBytes, sha256(manifestBytes), version);
  if (!parsed.ok) throw new Error(parsed.error);
  const manifest = parsed.value;
  const entries = Object.entries(manifest.targets);
  if (entries.length !== 1) throw new Error("each native job must declare exactly one target");
  const [targetId, target] = entries[0] ?? [];
  if (targetId === undefined || target === undefined) throw new Error("native job has no target");
  const smokeName = `bounded-v${version}-${targetId}-native-smoke-v1.json`;
  const expected = [manifestName, target.archive.name, smokeName].sort();
  if (names.join("\0") !== expected.join("\0")) throw new Error(`release input has missing or unexpected files: ${directory}`);
  for (const name of names) if (!lstatSync(join(directory, name)).isFile()) throw new Error(`release input contains a non-file: ${name}`);
  const archivePath = join(directory, target.archive.name);
  const archiveBytes = readFileSync(archivePath);
  const verified = await verifyReleaseArchive(manifest, targetId, archiveBytes);
  if (!verified.ok) throw new Error(`release archive ${target.archive.name} identity or contents mismatch: ${verified.error}`);
  let smoke: unknown;
  try {
    smoke = JSON.parse(readFileSync(join(directory, smokeName), "utf8"));
  } catch {
    throw new Error(`native smoke record is missing or malformed: ${smokeName}`);
  }
  if (!isRecord(smoke) || smoke.schema !== "bounded-native-smoke/1" || smoke.version !== version || smoke.target !== targetId || smoke.sourceCommit !== manifest.sourceCommit || smoke.archiveSha256 !== target.archive.sha256 || smoke.command !== "bounded --version" || smoke.exitCode !== 0 || Object.keys(smoke).sort().join(",") !== ["schema", "version", "target", "sourceCommit", "archiveSha256", "command", "exitCode"].sort().join(",")) {
    throw new Error(`native smoke record does not match archive identity: ${smokeName}`);
  }
  return { targetId, target, manifest, archivePath };
}

export async function assembleRelease(inputDirectories: readonly string[], outputDirectory: string): Promise<void> {
  if (inputDirectories.length === 0) throw new Error("release assembly requires at least one native job");
  const jobs: Job[] = [];
  for (const inputDirectory of inputDirectories) jobs.push(await readJob(inputDirectory));
  const first = jobs[0];
  if (first === undefined) throw new Error("release assembly has no inputs");
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.targetId)) throw new Error(`duplicate release target ${job.targetId}`);
    seen.add(job.targetId);
    if (job.manifest.version !== first.manifest.version || job.manifest.sourceCommit !== first.manifest.sourceCommit || job.manifest.builtWith !== first.manifest.builtWith || job.manifest.channel !== "stable") {
      throw new Error("native jobs have mismatched release identity or channel");
    }
  }
  const targets: Record<string, ReleaseTarget> = {};
  for (const targetId of targetIds) {
    const job = jobs.find((candidate) => candidate.targetId === targetId);
    if (job !== undefined) targets[targetId] = job.target;
  }
  const combined: ReleaseManifest = {
    schema: "bounded-release/1", version: first.manifest.version, channel: "stable",
    sourceCommit: first.manifest.sourceCommit, builtWith: first.manifest.builtWith, targets,
  };
  const manifestName = `bounded-v${combined.version}-manifest-v1.json`;
  const manifestBytes = Buffer.from(`${JSON.stringify(combined, null, 2)}\n`);
  const validated = readReleaseManifest(manifestBytes, sha256(manifestBytes), combined.version);
  if (!validated.ok) throw new Error(validated.error);
  const scripts = installerScripts(combined, sha256(manifestBytes));
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length !== 0) throw new Error("release assembly output must be empty");
  mkdirSync(outputDirectory, { recursive: true });
  for (const job of jobs) copyFileSync(job.archivePath, join(outputDirectory, job.target.archive.name));
  writeFileSync(join(outputDirectory, manifestName), manifestBytes);
  writeFileSync(join(outputDirectory, "install.sh"), scripts.unix, { mode: 0o755 });
  writeFileSync(join(outputDirectory, "install.ps1"), scripts.windows);
}
