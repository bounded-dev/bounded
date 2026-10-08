import type { Result } from "bounded/domain";

/** The brand only FileSetFingerprint itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const fileSetFingerprintBrand: unique symbol;

/** A fingerprint's wire form. */
export interface FileSetFingerprintJSON {
  readonly sha256: string;
  readonly fileCount: number;
}

/**
 * What a set of files held at one moment, in one hash: the SHA-256 (lowercase
 * hex) over each matching file's path and the SHA-256 of its bytes, in path
 * order, and how many files matched. Two fingerprints are equal exactly when
 * the same files held the same bytes (a link counts by where it points).
 */
export interface FileSetFingerprint {
  readonly __brand: "FileSetFingerprint";
  readonly [fileSetFingerprintBrand]: true;
  readonly sha256: string;
  readonly fileCount: number;
  /** Whether no file matched: a requirement over no files can never be met. */
  isEmpty(): boolean;
  equals(other: FileSetFingerprint): boolean;
  toJSON(): FileSetFingerprintJSON;
}

export interface FileSetFingerprintFactory {
  /** A frozen fingerprint from its wire form, or why the value is not one. Never throws. */
  parse(raw: unknown): Result<FileSetFingerprint>;
}
