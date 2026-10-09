import type { Result } from "../shared/result.ts";
import type { ListEffect, ListEffectJSON, ReadEffect, ReadEffectJSON, WriteEffect, WriteEffectJSON } from "./effect.contract.ts";
import type { ProjectPath } from "./project-path.contract.ts";

/** The brand only ShellCommandReading itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const shellCommandReadingBrand: unique symbol;

// What bounded made of a shell command (ADR 2026-020): the reading every
// execute effect carries, built by the host adapter, trusted code, from the
// model's tool input with bounded's shell command reader. The core holds its
// shape and checks it, never how a shell is read: a reading names programs,
// words and files, in the effects' own vocabulary, and says what could not be
// resolved rather than guess it.

/** A word of a command: literal text (quotes and escapes removed), or text only the shell can resolve, as written. */
export interface ShellCommandWord {
  readonly kind: "literal" | "unresolved";
  readonly text: string;
}

/** A program the command runs: its name and arguments, and the project directory it runs in, null when that cannot be known (the root is "."). */
export interface ShellProgramRun {
  readonly name: ShellCommandWord;
  readonly arguments: readonly ShellCommandWord[];
  readonly workingDirectory: ProjectPath | null;
}

/**
 * A file the command reads, lists or writes. `existenceUnknown` marks a
 * create or a modify of a path whose existence could not be told, so it is
 * given as both; present only when true.
 */
export interface ShellFileEffect {
  readonly effect: ReadEffect | ListEffect | WriteEffect;
  readonly existenceUnknown?: true;
}

/** The part a word would have played, had it been resolved: a file read, listed or written, a directory to run in, or code something runs. */
export type UnresolvedShellRole = "read" | "list" | "write" | "directory" | "code";

/** Text only the shell (or the program at run time) can make sense of, and the role it would have had. */
export interface UnresolvedShellPart {
  readonly text: string;
  readonly role: UnresolvedShellRole;
}

/** What every reading is: a value object, equal by value, whose wire form is plain data. */
interface ShellCommandReadingOf<Outcome extends string, Wire> {
  readonly __brand: "ShellCommandReading";
  readonly [shellCommandReadingBrand]: true;
  readonly outcome: Outcome;
  equals(other: ShellCommandReading): boolean;
  toJSON(): Wire;
}

/** A command that was read: every program it runs (nested and wrapped ones included, in the order met), its file effects, and what could not be resolved. */
export interface ReadShellCommandReading extends ShellCommandReadingOf<"read", ReadShellCommandReadingJSON> {
  readonly programs: readonly ShellProgramRun[];
  readonly fileEffects: readonly ShellFileEffect[];
  readonly unresolved: readonly UnresolvedShellPart[];
}

/**
 * Why a reader says it could not read a command, when the command itself is
 * to blame: it is too complex (too long, read too many ways, nested too
 * deep, costing too much to expand or too long to read), so splitting or
 * simplifying it would help. Absent, the reading failed for no reason the
 * command can change (a reader that failed, its parser failing, one too
 * slow, an answer that could not be used, a command the host adapter could
 * not give it): its why says which.
 */
export type UnreadShellCommandCause = "too-complex";

/** A command that could not be read, and why: a pack that needs the reading refuses it (fail closed). */
export interface UnreadShellCommandReading extends ShellCommandReadingOf<"unread", UnreadShellCommandReadingJSON> {
  readonly why: string;
  /** What the reader says made it unreadable, when it can tell; present only then. */
  readonly cause?: UnreadShellCommandCause;
}

/** What bounded made of a shell command: read, or unread with why. */
export type ShellCommandReading = ReadShellCommandReading | UnreadShellCommandReading;

// Wire forms: what toJSON gives and parse takes.
export interface ShellCommandWordJSON {
  readonly kind: "literal" | "unresolved";
  readonly text: string;
}
export interface ShellProgramRunJSON {
  readonly name: ShellCommandWordJSON;
  readonly arguments: readonly ShellCommandWordJSON[];
  readonly workingDirectory: string | null;
}
export interface ShellFileEffectJSON {
  readonly effect: ReadEffectJSON | ListEffectJSON | WriteEffectJSON;
  /** Written by toJSON only when true. */
  readonly existenceUnknown?: boolean;
}
export interface UnresolvedShellPartJSON {
  readonly text: string;
  readonly role: UnresolvedShellRole;
}
export interface ReadShellCommandReadingJSON {
  readonly outcome: "read";
  readonly programs: readonly ShellProgramRunJSON[];
  readonly fileEffects: readonly ShellFileEffectJSON[];
  readonly unresolved: readonly UnresolvedShellPartJSON[];
}
export interface UnreadShellCommandReadingJSON {
  readonly outcome: "unread";
  readonly why: string;
  /** Written by toJSON only when the reading has one. */
  readonly cause?: UnreadShellCommandCause;
}
export type ShellCommandReadingJSON = ReadShellCommandReadingJSON | UnreadShellCommandReadingJSON;

export interface ShellCommandReadingFactory {
  /** A frozen reading from its wire form, or why the value is not one. Never throws. */
  parse(raw: unknown): Result<ShellCommandReading>;
}
