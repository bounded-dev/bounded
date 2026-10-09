import type { Result, ShellCommandReading, ShellProgramRun } from "bounded/domain";

/** The brand only ProgramPrefix itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const programPrefixBrand: unique symbol;

/**
 * What would let bounded see what a command does, where it cannot: the
 * command written so that bounded can read it (`readable`), bounded's
 * dependencies reinstalled (`reinstall`), the command split or simplified
 * (`simplify`), its writes outside the project left out (`inside-project`),
 * or nothing but meeting the requirement (`none`: code, or a run passing the
 * rule's program as an argument).
 */
export type CannotSeeFix = "readable" | "reinstall" | "simplify" | "inside-project" | "none";

/**
 * What a command's reading makes of a program prefix: it runs it (`run` is
 * the matching program), it cannot be seen whether it does (why, and what
 * would let bounded see), or it does not.
 */
export type ProgramPrefixMatch =
  | { readonly kind: "runs"; readonly run: ShellProgramRun }
  | { readonly kind: "cannot-see"; readonly why: string; readonly fix: CannotSeeFix }
  | { readonly kind: "does-not-run" };

/**
 * A program and its leading arguments, as a rule's before.execute names them
 * (ADR 2026-019, amended): "terraform apply" is the program terraform with
 * the leading argument apply. Its wire form is its words joined by one space.
 */
export interface ProgramPrefix {
  readonly __brand: "ProgramPrefix";
  readonly [programPrefixBrand]: true;
  /** The program, by name: matched ignoring case against a run's name or the last segment of its path. */
  readonly program: string;
  /** The words the program receives first, matched exactly, after any options (an option possibly taking the next word). */
  readonly leadingArguments: readonly string[];
  /**
   * Whether the command read as `reading` runs the prefix. A run that
   * matches wins. Otherwise it cannot be seen when, first found in this
   * order: the reading is unread; a program's name is unresolved; a run of
   * the program reaches an unresolved argument before every word is found;
   * code is unresolved; a run passes the program as an argument (or a word
   * of one), so it may run it. Else it does not run.
   */
  matchIn(reading: ShellCommandReading): ProgramPrefixMatch;
  equals(other: ProgramPrefix): boolean;
  toJSON(): string;
}

export interface ProgramPrefixFactory {
  /**
   * A frozen prefix, its spaces tidied, or why the value is not one: not
   * text, empty, holding whitespace other than a space or a control
   * character, longer than 1000 characters, more than 16 words, holding a
   * character the shell would read, a program named by a path, holding '~'
   * or '=', a word of the shell's own grammar, or an option. Never throws.
   */
  parse(raw: unknown): Result<ProgramPrefix>;
}
