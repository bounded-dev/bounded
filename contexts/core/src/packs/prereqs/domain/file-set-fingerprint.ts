import type { fileSetFingerprintBrand } from "./file-set-fingerprint.contract.ts";
import { own, type Result, readSafely, sameWire, wireFormOf } from "bounded/domain";
import type * as Contract from "./file-set-fingerprint.contract.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const FORM = "A file-set fingerprint is { sha256, fileCount }";
const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });

class FileSetFingerprintImpl implements Contract.FileSetFingerprint {
  declare readonly __brand: "FileSetFingerprint";
  declare readonly [fileSetFingerprintBrand]: true;
  readonly #made = true;

  private constructor(
    readonly sha256: string,
    readonly fileCount: number,
  ) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is FileSetFingerprintImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.FileSetFingerprint> {
    return readSafely<Contract.FileSetFingerprint>("A file-set fingerprint", () => {
      const given = FileSetFingerprintImpl.made(raw) ? wireFormOf(raw) : raw;
      if (typeof given !== "object" || given === null || Array.isArray(given)) return refuse(FORM);
      const keys = Object.keys(given);
      if (keys.length !== 2 || !keys.includes("sha256") || !keys.includes("fileCount")) return refuse(FORM);
      const [sha256, fileCount] = [own(given, "sha256"), own(given, "fileCount")];
      if (typeof sha256 !== "string" || !SHA256.test(sha256)) return refuse("A file-set fingerprint's sha256 is a SHA-256 in lowercase hex");
      if (typeof fileCount !== "number" || !Number.isSafeInteger(fileCount) || fileCount < 0) return refuse("A file-set fingerprint's fileCount is a whole number of files, 0 or more");
      return { ok: true, value: new FileSetFingerprintImpl(sha256, fileCount) };
    });
  }

  isEmpty(): boolean {
    return this.fileCount === 0;
  }

  equals(other: Contract.FileSetFingerprint): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.FileSetFingerprintJSON {
    return { sha256: this.sha256, fileCount: this.fileCount };
  }
}

export type FileSetFingerprint = Contract.FileSetFingerprint;
export const FileSetFingerprint: Contract.FileSetFingerprintFactory = FileSetFingerprintImpl;
