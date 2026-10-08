import type { Result } from "bounded/domain";
import { checkFilePattern, fileSetOf } from "../../domain/file-set.ts";
import type { FileSetFingerprints } from "./check-prerequisites.contract.ts";

const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** A project's files in memory, fingerprinted: a test double of FileSetFingerprints, for tests only (ADR 2026-017). */
export class InMemoryFileSetFingerprints implements FileSetFingerprints {
  readonly files: Map<string, string>;
  /** When set, every fingerprint fails with it. */
  failure: string | undefined;
  /** How many fingerprints were asked for. */
  calls = 0;

  constructor(files: Readonly<Record<string, string>> = {}) {
    this.files = new Map(Object.entries(files));
  }

  async fingerprint(patterns: readonly string[]): Promise<Result<unknown>> {
    this.calls++;
    if (this.failure !== undefined) return { ok: false, error: this.failure };
    const checked: string[] = [];
    for (const raw of patterns) {
      const pattern = checkFilePattern(raw, "unchangedSince");
      if (!pattern.ok) return pattern;
      checked.push(pattern.value);
    }
    const set = fileSetOf(checked);
    const matching = [...this.files.entries()].filter(([path]) => set.matches(path)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return { ok: true, value: { sha256: sha256(matching.map(([path, content]) => `${path}\0${sha256(content)}\n`).join("")), fileCount: matching.length } };
  }
}
