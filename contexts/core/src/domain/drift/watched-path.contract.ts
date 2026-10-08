import type { Composition } from "../composition/composition.contract.ts";
import type { Result } from "../shared/result.ts";

/** A change a shell command can make to a file. */
export type WatchedChange = "create" | "modify" | "delete";

/**
 * Files a shell command must not change: those `match` finds and no
 * pattern in `except` does (project-relative globs), the changes it must not
 * make to them, why they are watched, and what to do instead. A shell
 * command's changes of those kinds are undone; others are left alone.
 */
export interface WatchedPath {
  readonly __brand: "WatchedPath";
  readonly match: string;
  readonly except: readonly string[];
  /** The changes a command must not make, in the order create, modify, delete. */
  readonly changes: readonly WatchedChange[];
  readonly why: string;
  readonly redirect: string;
  equals(other: WatchedPath): boolean;
  toJSON(): WatchedPathJSON;
}

/** A watched path's wire form: what its toJSON gives, and what WatchedPath.parse and the watchedPaths point take. */
export interface WatchedPathJSON {
  readonly match: string;
  readonly except?: readonly string[];
  /** Every change when left out. */
  readonly changes?: readonly WatchedChange[];
  readonly why: string;
  readonly redirect: string;
}

/**
 * Watched paths worked out from the composition, such as from another
 * point's rules: called each time the watched files are hashed. Each is
 * checked with WatchedPath.parse.
 */
export type WatchedPathSource = (composition: Composition) => readonly (WatchedPath | WatchedPathJSON)[];

export interface WatchedPathFactory {
  /** A frozen watched path, `except` always a list, or why the value is not one. */
  parse(raw: unknown): Result<WatchedPath>;
}
