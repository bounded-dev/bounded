import type { Result } from "../shared/result.ts";

/** The shell command an execute effect runs, exactly as given: not blank, without NUL or control characters other than tab and line breaks. */
export interface Command {
  readonly __brand: "Command";
  readonly value: string;
  equals(other: Command): boolean;
  toJSON(): string;
}

export interface CommandFactory {
  /** A valid command, or why the value is not one. */
  parse(raw: unknown): Result<Command>;
}
