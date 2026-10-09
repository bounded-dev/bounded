import type { Result } from "bounded/domain";

/** The brand only Snapshot itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const snapshotBrand: unique symbol;

/**
 * A watched file: the SHA-256 of its bytes (hex), its size in bytes, and the
 * index of the first rule that watches it. A link is never followed: `link`
 * is true, and its hash is of where it points.
 */
export interface WatchedFile {
  readonly hash: string;
  readonly size: number;
  readonly rule: number;
  /** Every rule that watches it, in order, when more than one does: a change any of them forbids is undone. */
  readonly rules?: readonly number[];
  readonly link?: true;
}

/**
 * How a file can be put back as it was before a command: from the commit
 * (its content matched it), from a copy of its bytes (base64), or nowhere
 * (too large to copy: a change is reported, never replaced).
 */
export type Kept = { readonly from: "commit" } | { readonly from: "copy"; readonly content: string; readonly executable: boolean } | { readonly from: "nowhere" };

/** A watched file before a command, and how it can be put back. */
export interface SnapshotFile extends WatchedFile {
  readonly kept: Kept;
}

/** A snapshot's wire form: what is stored between a call and its result. */
export interface SnapshotJSON {
  readonly commit: string | null;
  readonly files: Readonly<Record<string, SnapshotFile>>;
}

/**
 * The watched files before a shell command, and the commit they were
 * compared with (null outside git or before a first commit). Its form is
 * checked when it is parsed; whether its copies and committed files match
 * their hashes needs the files themselves, so the feature that restores
 * from it checks that.
 */
export interface Snapshot {
  readonly __brand: "Snapshot";
  readonly [snapshotBrand]: true;
  readonly commit: string | null;
  readonly files: Readonly<Record<string, SnapshotFile>>;
  equals(other: Snapshot): boolean;
  toJSON(): SnapshotJSON;
}

export interface SnapshotFactory {
  /**
   * A frozen snapshot from its wire form, watched by `ruleCount` rules, or
   * why it is not one: not a snapshot, a hash that is not a SHA-256, a file
   * whose fields are not a snapshot file's (a rule index past the rules), or
   * a copy that is not base64 text with an executable flag. Never throws.
   */
  parse(raw: unknown, ruleCount: number): Result<Snapshot>;
}
