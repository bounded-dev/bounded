import type { Result } from "../shared/result.ts";

/** The brand only Command itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const commandBrand: unique symbol;

/** The shell command an execute effect runs, exactly as given: not blank, without NUL or control characters other than tab and line breaks. */
export interface Command {
  readonly __brand: "Command";
  readonly [commandBrand]: true;
  readonly value: string;
  equals(other: Command): boolean;
  toJSON(): string;
}

export interface CommandFactory {
  /** A valid command, or why the value is not one. */
  parse(raw: unknown): Result<Command>;
}
