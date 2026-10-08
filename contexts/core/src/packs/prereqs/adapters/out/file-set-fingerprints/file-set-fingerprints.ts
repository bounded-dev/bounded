import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Result } from "bounded/domain";
import type { FileSetFingerprints } from "../../../application/check-prerequisites/check-prerequisites.contract.ts";
import { checkFilePattern, fileSetOf } from "../../../domain/file-set.ts";

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const text = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

/**
 * The project's files on disk, fingerprinted: a walk of only the directories
 * a pattern's fixed leading path can lead to, never into .bounded,
 * node_modules or .git, and never through a linked directory. Every file is
 * seen, whatever version control ignores. A symbolic link is never followed:
 * one to a directory the patterns could reach into, or one whose own path the
 * patterns match (a link to a file, or a dangling one), makes the fingerprint
 * fail, naming it, since what it points at cannot be checked; any other link
 * is ignored. So does an entry the patterns match that is neither a file, a
 * directory nor a link (a FIFO, a socket, a device), failing closed. The
 * fingerprint is the SHA-256 over each matching file's path, a NUL, the
 * SHA-256 of its bytes and a newline, in path order.
 */
export class FileSystemFileSetFingerprints implements FileSetFingerprints {
  constructor(private readonly root: string) {}

  async fingerprint(patterns: readonly string[]): Promise<Result<unknown>> {
    try {
      const checked: string[] = [];
      for (const raw of patterns) {
        const pattern = checkFilePattern(raw, "unchangedSince");
        if (!pattern.ok) return pattern;
        checked.push(pattern.value);
      }
      const set = fileSetOf(checked);
      const lines: string[] = [];
      /** The first entry the set cannot be fingerprinted with: a link it reaches, or a special file it names. */
      let unfingerprintable: string | undefined;
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(join(this.root, dir), { withFileTypes: true })) {
          const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
          // readdir does not follow links: a linked directory is a link here, never walked.
          if (entry.isDirectory()) {
            if (set.mayHold(path)) await walk(path);
          } else if (entry.isFile()) {
            if (set.matches(path)) lines.push(`${path}\0${sha256(await readFile(join(this.root, path)))}\n`);
          } else if (unfingerprintable !== undefined) {
            continue;
          } else if (entry.isSymbolicLink()) {
            // A link to a directory counts wherever the patterns could reach into it; any other only where they match it.
            const toDirectory = await stat(join(this.root, path)).then(
              (target) => target.isDirectory(),
              () => false,
            );
            if (set.matches(path) || (toDirectory && set.mayHold(path))) {
              unfingerprintable = `${path} is a symbolic link, and a link's target is never fingerprinted, so the files it names cannot be checked: replace the link with the files, or leave it out of the patterns`;
            }
          } else if (set.matches(path)) {
            unfingerprintable = `${path} is neither a file, a directory nor a link (a FIFO, a socket or a device), so it cannot be fingerprinted: remove it, or leave it out of the patterns`;
          }
        }
      };
      await walk("");
      if (unfingerprintable !== undefined) return { ok: false, error: unfingerprintable };
      lines.sort();
      return { ok: true, value: { sha256: sha256(lines.join("")), fileCount: lines.length } };
    } catch (thrown) {
      return { ok: false, error: `the project's files could not be read: ${text(thrown)}` };
    }
  }
}
