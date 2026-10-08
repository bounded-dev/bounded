import type { Result } from "bounded/domain";

/** Which field of a rule a pattern comes from, for the messages that name it. */
export type FilePatternField = "unchangedSince" | "before.write";

/**
 * The project files a list of checked patterns names. Patterns are matched
 * as the path gate matches a rule's `match`: ignoring case, seeing dotfiles;
 * a pattern without a glob covers everything under it. Bounded's own state
 * (`.bounded`), `node_modules` and `.git`, at any depth, are never in it.
 */
export interface FileSet {
  readonly patterns: readonly string[];
  /** Whether the project-relative file `path` is in the set. */
  matches(path: string): boolean;
  /** Whether the project-relative directory `dir` may hold a file in the set: only on a pattern's fixed leading path, never a directory that is never in it. */
  mayHold(dir: string): boolean;
}

/**
 * A pattern from `field` of a rule, checked as the path gate checks its
 * patterns and tidied (NFC, no './', no empty parts), or why it is not one:
 * not text, empty, absolute, climbing with '..', negated, with parentheses, a
 * '/' or '**' inside a group, more than three wildcards in one part, not a
 * glob picomatch compiles, longer than 512 characters, or inside `.bounded`,
 * Bounded's own state, which no rule may name.
 */
export type CheckFilePattern = (raw: unknown, field: FilePatternField) => Result<string>;

/** The file set named by patterns already checked by checkFilePattern. */
export type FileSetOf = (patterns: readonly string[]) => FileSet;
