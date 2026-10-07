import type { Result } from "../shared/result.ts";

/**
 * Files a shell command must not change: those `match` finds and no
 * pattern in `except` does (project-relative globs), why they are watched,
 * and what to do instead. A shell command's changes to them are undone.
 */
export interface WatchedPath {
  readonly match: string;
  readonly except?: readonly string[];
  readonly why: string;
  readonly redirect: string;
}

export interface WatchedPathFactory {
  /** A frozen watched path, `except` always a list, or why the value is not one. */
  parse(raw: unknown): Result<WatchedPath>;
}
