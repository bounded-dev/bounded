import type { WatchedPath } from "./watched-path.contract.ts";

// How watched paths meet files, for every WatchedFiles adapter: a rule's
// match ignores case, as the protected-paths pack's does, so a protected file cannot be
// dodged by its case on a case-insensitive file system; its except is exact,
// so a carve-out never grows. Version control's and bounded's own
// directories are never watched, nor anything inside node_modules: drift
// does not protect dependencies.

/** Whether `path` is, or is inside, .bounded at the root, or a node_modules or .git directory at any depth: never watched. */
export type IsOwnState = (path: string) => boolean;

/** For `rules`: the indexes of every rule that watches a path, in order; none when no rule does. A path holding a control character is watched conservatively. */
export type Watcher = (rules: readonly WatchedPath[]) => (path: string) => readonly number[];

/** A watched file's rule fields from the rules that watch it: the first as its rule, all of them when there are several. */
export type RuleFields = (by: readonly number[]) => { rule: number; rules?: readonly number[] };

/** For `rules`: whether a directory may hold a watched file, so a walk need not enter the others. */
export type MayHold = (rules: readonly WatchedPath[]) => (dir: string) => boolean;

/** Whether `path` is a plain project-relative path: not absolute, without '..' or empty parts. */
export type IsInside = (path: string) => boolean;
