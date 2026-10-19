import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import type { Result } from "bounded/domain";
import tar from "tar-stream";
import yauzl from "yauzl";

export interface ExpectedArchiveFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const reservedWindowsName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/** One portable archive path spelling across macOS, Linux and Windows. */
export function safeReleasePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith("/")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.endsWith(".") && !reservedWindowsName.test(part));
}

const canonicalPath = (path: string): string => path.toLowerCase();

function relativeMemberPath(name: string, releaseRoot: string): Result<string> {
  const prefix = `${releaseRoot}/`;
  if (!name.startsWith(prefix)) return { ok: false, error: `archive member ${name} is outside ${releaseRoot}` };
  const relativePath = name.slice(prefix.length);
  if (!safeReleasePath(relativePath)) return { ok: false, error: `archive member ${name} has an unsafe path` };
  return { ok: true, value: relativePath };
}

async function verifiedStreamBytes(stream: Readable, expected: ExpectedArchiveFile): Promise<Result<Uint8Array>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.byteLength;
    if (size > expected.size) return { ok: false, error: `archive file ${expected.path} exceeds its declared size` };
    chunks.push(data);
  }
  const content = Buffer.concat(chunks);
  if (content.byteLength !== expected.size || sha256(content) !== expected.sha256) return { ok: false, error: `archive file ${expected.path} fails size or SHA-256 verification` };
  return { ok: true, value: content };
}

function expectedFileMap(expectedFiles: readonly ExpectedArchiveFile[]): Map<string, ExpectedArchiveFile> {
  return new Map(expectedFiles.map((file) => [file.path, file]));
}

function completeEntries(expectedFiles: readonly ExpectedArchiveFile[], entries: Record<string, Uint8Array>): Result<Readonly<Record<string, Uint8Array>>> {
  if (Object.keys(entries).length !== expectedFiles.length) return { ok: false, error: "release archive has missing entries" };
  return { ok: true, value: entries };
}

async function readTarGzip(archiveBytes: Uint8Array, releaseRoot: string, expectedFiles: readonly ExpectedArchiveFile[]): Promise<Result<Readonly<Record<string, Uint8Array>>>> {
  const expected = expectedFileMap(expectedFiles);
  const entries: Record<string, Uint8Array> = {};
  const seenPaths = new Set<string>();
  const maximumTarBytes = expectedFiles.reduce((total, file) => total + file.size, 0) + (expectedFiles.length + 1) * 4096 + 1024 * 1024;
  try {
    const tarBytes = gunzipSync(Buffer.from(archiveBytes), { maxOutputLength: maximumTarBytes });
    const extract = tar.extract();
    extract.end(tarBytes);
    for await (const entry of extract) {
      const path = relativeMemberPath(entry.header.name, releaseRoot);
      if (!path.ok) return path;
      const folded = canonicalPath(path.value);
      if (seenPaths.has(folded)) return { ok: false, error: `archive member ${entry.header.name} duplicates another path` };
      seenPaths.add(folded);
      const file = expected.get(path.value);
      if (entry.header.type !== "file" || file === undefined) return { ok: false, error: `archive member ${entry.header.name} is not a declared regular file` };
      if (entry.header.size !== file.size) return { ok: false, error: `archive file ${path.value} has the wrong size` };
      const content = await verifiedStreamBytes(entry, file);
      if (!content.ok) return content;
      entries[path.value] = content.value;
    }
    return completeEntries(expectedFiles, entries);
  } catch (error) {
    return { ok: false, error: `cannot parse verified tar.gz archive: ${String(error)}` };
  }
}

async function readZip(archiveBytes: Uint8Array, releaseRoot: string, expectedFiles: readonly ExpectedArchiveFile[]): Promise<Result<Readonly<Record<string, Uint8Array>>>> {
  const expected = expectedFileMap(expectedFiles);
  const entries: Record<string, Uint8Array> = {};
  const seenPaths = new Set<string>();
  let zip: Awaited<ReturnType<typeof yauzl.fromBufferPromise>> | undefined;
  try {
    zip = await yauzl.fromBufferPromise(Buffer.from(archiveBytes), { strictFileNames: true, validateEntrySizes: true });
    for await (const entry of zip.eachEntry()) {
      const path = relativeMemberPath(entry.fileName, releaseRoot);
      if (!path.ok) return path;
      const folded = canonicalPath(path.value);
      if (seenPaths.has(folded)) return { ok: false, error: `archive member ${entry.fileName} duplicates another path` };
      seenPaths.add(folded);
      const file = expected.get(path.value);
      const unixMode = entry.externalFileAttributes >>> 16;
      const fileType = unixMode & 0o170000;
      if ((entry.versionMadeBy >>> 8) === 3 && fileType !== 0 && fileType !== 0o100000) return { ok: false, error: `archive member ${entry.fileName} is not a regular file` };
      if (file === undefined) return { ok: false, error: `archive member ${entry.fileName} is not declared` };
      if (entry.uncompressedSize !== file.size) return { ok: false, error: `archive file ${path.value} has the wrong size` };
      const content = await verifiedStreamBytes(await zip.openReadStreamPromise(entry), file);
      if (!content.ok) return content;
      entries[path.value] = content.value;
    }
    return completeEntries(expectedFiles, entries);
  } catch (error) {
    return { ok: false, error: `cannot parse verified ZIP archive: ${String(error)}` };
  } finally {
    zip?.close();
  }
}

/** Parses only the hash-verified archive bytes, returning files after every member passes. */
export async function readReleaseArchive(archiveBytes: Uint8Array, archiveName: string, version: string, expectedFiles: readonly ExpectedArchiveFile[]): Promise<Result<Readonly<Record<string, Uint8Array>>>> {
  const releaseRoot = `bounded-v${version}`;
  return archiveName.endsWith(".tar.gz") ? readTarGzip(archiveBytes, releaseRoot, expectedFiles) : readZip(archiveBytes, releaseRoot, expectedFiles);
}
