#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import yazl from "yazl";
import { buildDist, PREREQS_STATUS_BAND_FILES } from "./build-dist.ts";
import { readReleaseManifest, verifyReleaseArchive, type ReleaseFile, type ReleaseManifest } from "./cli/release-manifest.ts";
import { assembleRelease } from "./release-assembly.ts";

const HERE = import.meta.dir;
const packageManifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")) as { version: string };
const targets: Readonly<Record<string, { bun: string; minimumOS: string; extension: "zip" | "tar.gz" }>> = {
  "darwin-x64": { bun: "bun-darwin-x64", minimumOS: "macOS 13", extension: "zip" },
  "darwin-arm64": { bun: "bun-darwin-arm64", minimumOS: "macOS 13", extension: "zip" },
  "linux-x64-gnu": { bun: "bun-linux-x64", minimumOS: "Linux kernel 3.10, glibc 2.17", extension: "tar.gz" },
  "linux-arm64-gnu": { bun: "bun-linux-arm64", minimumOS: "Linux kernel 3.10, glibc 2.17", extension: "tar.gz" },
  "linux-x64-musl": { bun: "bun-linux-x64-musl", minimumOS: "Linux kernel 3.10, musl", extension: "tar.gz" },
  "linux-arm64-musl": { bun: "bun-linux-arm64-musl", minimumOS: "Linux kernel 3.10, musl", extension: "tar.gz" },
  "windows-x64": { bun: "bun-windows-x64", minimumOS: "Windows 10 1809", extension: "zip" },
  "windows-arm64": { bun: "bun-windows-arm64", minimumOS: "Windows 10 1809", extension: "zip" },
};
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const descriptor = (path: string, bytes: Uint8Array): ReleaseFile => ({ path, size: bytes.byteLength, sha256: digest(bytes) });

async function declarationFiles(): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  const root = join(HERE, "dist", "types");
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".d.ts")) files[`share/types/${relative(root, path).replaceAll("\\", "/")}`] = readFileSync(path);
    }
  }
  await visit(root);
  files["share/types/index.d.ts"] = Buffer.from('export * from "./core/domain/index.js";\nexport * from "./core/application/index.js";\n');
  return files;
}

function tarGzip(files: Readonly<Record<string, Uint8Array>>, root: string): Promise<Uint8Array> {
  return new Promise((resolveArchive, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("error", reject);
    pack.on("end", () => resolveArchive(gzipSync(Buffer.concat(chunks))));
    for (const [path, bytes] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
      pack.entry({ name: `${root}/${path}`, size: bytes.byteLength, mode: path.startsWith("bin/") ? 0o755 : 0o644, type: "file", mtime: new Date(0), uid: 0, gid: 0, uname: "", gname: "" } as Parameters<typeof pack.entry>[0], Buffer.from(bytes));
    }
    pack.finalize();
  });
}

function zip(files: Readonly<Record<string, Uint8Array>>, root: string): Promise<Uint8Array> {
  return new Promise((resolveArchive, reject) => {
    const archive = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on("error", reject);
    archive.outputStream.on("end", () => resolveArchive(Buffer.concat(chunks)));
    for (const [path, bytes] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
      archive.addBuffer(Buffer.from(bytes), `${root}/${path}`, { mode: path.startsWith("bin/") ? 0o100755 : 0o100644, mtime: new Date("1980-01-01T00:00:00Z") });
    }
    archive.end();
  });
}

function sourceCommit(): string {
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: HERE, stdout: "pipe", stderr: "pipe" });
  if (commit.exitCode !== 0) throw new Error(`cannot identify release source commit: ${commit.stderr.toString()}`);
  return commit.stdout.toString().trim();
}

function requireCleanSource(): void {
  const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: HERE, stdout: "pipe", stderr: "pipe" });
  if (status.exitCode !== 0 || status.stdout.toString().trim().length > 0) {
    throw new Error("stable release requires a clean source checkout with no uncommitted or untracked files");
  }
}

export async function buildRelease(targetId: string, outputDirectory: string, smoke = false): Promise<void> {
  const target = targets[targetId];
  if (target === undefined) throw new Error(`unsupported release target ${targetId}`);
  if (!smoke) requireCleanSource();
  await buildDist();
  await mkdir(outputDirectory, { recursive: true });
  const executableName = targetId.startsWith("windows-") ? "bounded.exe" : "bounded";
  const executablePath = join(HERE, "dist", "standalone", executableName);
  const treeSitterWasm = join(HERE, "..", "node_modules", "@vscode", "tree-sitter-wasm", "wasm");
  await mkdir(join(HERE, "dist", "standalone"), { recursive: true });
  const compiled = Bun.spawnSync([
    process.execPath, "build", join(HERE, "standalone-main.ts"), "--compile", "--target", target.bun,
    "--asset", join(treeSitterWasm, "tree-sitter.wasm"),
    "--asset", join(treeSitterWasm, "tree-sitter-bash.wasm"),
    "--outfile", executablePath,
  ], { cwd: join(HERE, "dist", "standalone"), stdout: "pipe", stderr: "pipe" });
  if (compiled.exitCode !== 0) throw new Error(`standalone compilation failed:\n${compiled.stdout.toString()}${compiled.stderr.toString()}`);
  copyFileSync(executablePath, join(outputDirectory, executableName));
  const commit = sourceCommit();
  const files: Record<string, Uint8Array> = {
    [`bin/${executableName}`]: readFileSync(executablePath),
    LICENSE: readFileSync(join(HERE, "LICENSE")),
    "release.json": Buffer.from(`${JSON.stringify({ version: packageManifest.version, target: targetId, sourceCommit: commit, protocolVersion: 1 })}\n`),
    ...await declarationFiles(),
  };
  const pluginRoot = join(HERE, "hosts", "claude-code", "prereqs-status-band");
  for (const path of PREREQS_STATUS_BAND_FILES) files[`share/claude-code/prereqs-status-band/${path}`] = readFileSync(join(pluginRoot, path));
  const root = `bounded-v${packageManifest.version}`;
  const archiveBytes = target.extension === "zip" ? await zip(files, root) : await tarGzip(files, root);
  const archiveName = `${root}-${targetId}.${target.extension}`;
  const manifest: ReleaseManifest = {
    schema: "bounded-release/1", version: packageManifest.version, channel: "stable", sourceCommit: commit,
    builtWith: `Bun ${Bun.version}`,
    targets: { [targetId]: {
      minimumOS: target.minimumOS,
      archive: { name: archiveName, size: archiveBytes.byteLength, sha256: digest(archiveBytes) },
      executable: descriptor(`bin/${executableName}`, files[`bin/${executableName}`] ?? new Uint8Array()),
      files: Object.entries(files).filter(([path]) => path !== `bin/${executableName}`).map(([path, bytes]) => descriptor(path, bytes)).sort((left, right) => left.path.localeCompare(right.path)),
    } },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(smoke ? { ...manifest, channel: "development" } : manifest, null, 2)}\n`);
  const parsed = readReleaseManifest(smoke ? Buffer.from(manifestBytes.toString().replace('"development"', '"stable"')) : manifestBytes, smoke ? digest(Buffer.from(manifestBytes.toString().replace('"development"', '"stable"'))) : digest(manifestBytes), packageManifest.version);
  if (!parsed.ok) throw new Error(parsed.error);
  const verified = await verifyReleaseArchive(parsed.value, targetId, archiveBytes);
  if (!verified.ok) throw new Error(verified.error);
  writeFileSync(join(outputDirectory, archiveName), archiveBytes);
  writeFileSync(join(outputDirectory, `${root}-manifest-v1.json`), manifestBytes);
  if (!smoke) {
    const executable = Bun.spawnSync([executablePath, "--version"], { cwd: outputDirectory, stdout: "pipe", stderr: "pipe" });
    if (executable.exitCode !== 0 || !executable.stdout.toString().includes(packageManifest.version)) throw new Error("native executable smoke failed");
    writeFileSync(join(outputDirectory, `${root}-${targetId}-native-smoke-v1.json`), `${JSON.stringify({ schema: "bounded-native-smoke/1", version: packageManifest.version, target: targetId, sourceCommit: commit, archiveSha256: digest(archiveBytes), command: "bounded --version", exitCode: 0 })}\n`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--assemble") {
    const inputDirectories: string[] = [];
    let outputDirectory: string | undefined;
    for (let index = 1; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (value === undefined) throw new Error("release assembly flag has no value");
      if (flag === "--input") inputDirectories.push(resolve(value));
      else if (flag === "--out" && outputDirectory === undefined) outputDirectory = resolve(value);
      else throw new Error(`unknown or repeated release assembly option ${flag}`);
    }
    if (outputDirectory === undefined) throw new Error("release assembly requires --out");
    await assembleRelease(inputDirectories, outputDirectory);
  } else {
    const [targetFlag, targetId, maybeSmoke, maybeOutputFlag, maybeOutputDirectory] = args;
    const smoke = maybeSmoke === "--smoke";
    const outputFlag = smoke ? maybeOutputFlag : maybeSmoke;
    const outputDirectory = smoke ? maybeOutputDirectory : maybeOutputFlag;
    if (targetFlag !== "--target" || targetId === undefined || outputFlag !== "--out" || outputDirectory === undefined || args.length !== (smoke ? 5 : 4)) throw new Error("usage: bun src/build-release.ts --target <target> [--smoke] --out <directory>");
    await buildRelease(targetId, resolve(outputDirectory), smoke);
  }
}
