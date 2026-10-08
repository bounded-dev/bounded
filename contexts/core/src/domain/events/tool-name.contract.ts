import type { Result } from "../shared/result.ts";

/** A tool an invoke effect calls, as the host names it: not blank, without NUL or control characters. */
export interface ToolName {
  readonly __brand: "ToolName";
  readonly value: string;
  equals(other: ToolName): boolean;
  toJSON(): string;
}

export interface ToolNameFactory {
  /** A valid toolName, or why the value is not one. */
  parse(raw: unknown): Result<ToolName>;
}
