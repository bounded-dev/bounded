import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import yazl from "yazl";
import { catalogue } from "../managed-pack-artifact.test-support.ts";

export const TARGET_IDS = [
  "darwin-arm64", "darwin-x64", "linux-arm64-gnu", "linux-arm64-musl",
  "linux-x64-gnu", "linux-x64-musl", "windows-arm64", "windows-x64",
] as const;
export type TargetId = (typeof TARGET_IDS)[number];
export const COMMIT = "0123456789abcdef";
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

async function archiveFor(targetId: TargetId, version: string, files: Readonly<Record<string, Uint8Array>>): Promise<Uint8Array> {
  const root = `bounded-v${version}`;
  if (!targetId.startsWith("linux-")) {
    return new Promise((resolveArchive, reject) => {
      const zip = new yazl.ZipFile();
      const chunks: Buffer[] = [];
      zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      zip.outputStream.on("error", reject);
      zip.outputStream.on("end", () => resolveArchive(Buffer.concat(chunks)));
      for (const [path, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
        zip.addBuffer(Buffer.from(content), `${root}/${path}`, { mode: path.startsWith("bin/") ? 0o100755 : 0o100644, mtime: new Date("1980-01-01T00:00:00Z") });
      }
      zip.end();
    });
  }
  return new Promise((resolveArchive, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("error", reject);
    pack.on("end", () => resolveArchive(gzipSync(Buffer.concat(chunks))));
    for (const [path, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      pack.entry({ name: `${root}/${path}`, size: content.byteLength, mode: path.startsWith("bin/") ? 0o755 : 0o644, type: "file", mtime: new Date(0), uid: 0, gid: 0, uname: "", gname: "" } as Parameters<typeof pack.entry>[0], Buffer.from(content));
    }
    pack.finalize();
  });
}

/** A valid, target-specific release archive and matching one-target manifest, without trusted provenance. */
export async function nativeJob(directory: string, targetId: TargetId, version: string, options: { channel?: string; sourceCommit?: string; builtWith?: string; catalogPackage?: string; catalogVersion?: string; duplicateCatalogPack?: boolean } = {}): Promise<{ archiveName: string; archiveBytes: Uint8Array }> {
  mkdirSync(directory, { recursive: true });
  const sourceCommit = options.sourceCommit ?? COMMIT;
  const executablePath = targetId.startsWith("windows-") ? "bin/bounded.exe" : "bin/bounded";
  const executableBytes = bytes(`bounded executable for ${targetId}\n`);
  const builtCatalogue = catalogue(options.catalogPackage ?? "bounded", options.catalogVersion ?? version);
  const releaseCatalogue = options.duplicateCatalogPack
    ? { ...builtCatalogue, packs: [...builtCatalogue.packs, builtCatalogue.packs[0]] }
    : builtCatalogue;
  const files: Record<string, Uint8Array> = {
    [executablePath]: executableBytes,
    LICENSE: bytes("MIT test license\n"),
    "release.json": bytes(`${JSON.stringify({ version, target: targetId, sourceCommit, protocolVersion: 1 })}\n`),
    "share/catalog/bounded.catalog.json": bytes(`${JSON.stringify(releaseCatalogue)}\n`),
    "share/types/index.d.ts": bytes("export declare const bounded: true;\n"),
    "share/claude-code/prereqs-status-band/.claude-plugin/plugin.json": bytes(JSON.stringify({ name: "bounded-prereqs-status-band", version, types: "./types/index.d.ts" })),
    "share/claude-code/prereqs-status-band/hooks/hooks.json": bytes('{"hooks":{}}'),
    "share/claude-code/prereqs-status-band/hooks/register.ts": bytes("export {};\n"),
    "share/claude-code/prereqs-status-band/hooks/engine-subset.ts": bytes("export {};\n"),
    "share/claude-code/prereqs-status-band/hooks/prereqs-status-band-lines.ts": bytes("export {};\n"),
    "share/claude-code/prereqs-status-band/hooks/prereqs-status-file.ts": bytes("export {};\n"),
    "share/claude-code/prereqs-status-band/hooks/project-config-names.ts": bytes("export {};\n"),
    "share/claude-code/prereqs-status-band/types/index.d.ts": bytes("export {};\n"),
  };
  const archiveBytes = await archiveFor(targetId, version, files);
  const archiveName = `bounded-v${version}-${targetId}.${targetId.startsWith("linux-") ? "tar.gz" : "zip"}`;
  const manifest = {
    schema: "bounded-release/1", version, channel: options.channel ?? "stable", sourceCommit, builtWith: options.builtWith ?? "Bun 1.3.14",
    targets: { [targetId]: {
      minimumOS: targetId.startsWith("linux-") ? "Linux test host" : targetId.startsWith("windows-") ? "Windows test host" : "macOS test host",
      archive: { name: archiveName, size: archiveBytes.byteLength, sha256: sha256(archiveBytes) },
      executable: { path: executablePath, size: executableBytes.byteLength, sha256: sha256(executableBytes) },
      files: Object.entries(files).filter(([path]) => path !== executablePath).map(([path, content]) => ({ path, size: content.byteLength, sha256: sha256(content) })).sort((a, b) => a.path.localeCompare(b.path)),
    } },
  };
  writeFileSync(join(directory, archiveName), archiveBytes);
  writeFileSync(join(directory, `bounded-v${version}-manifest-v1.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, `bounded-v${version}-${targetId}-native-smoke-v1.json`), `${JSON.stringify({
    schema: "bounded-native-smoke/1", version, target: targetId, sourceCommit,
    archiveSha256: sha256(archiveBytes), command: "bounded --version", exitCode: 0,
  })}\n`);
  return { archiveName, archiveBytes };
}
