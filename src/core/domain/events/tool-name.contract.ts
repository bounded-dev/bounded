import type { Result } from "../shared/result.ts";

/** The brand only ToolName itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const toolNameBrand: unique symbol;

/** A tool an invoke effect calls, as the host names it: not blank, without NUL or control characters. */
export interface ToolName {
  readonly __brand: "ToolName";
  readonly [toolNameBrand]: true;
  readonly value: string;
  equals(other: ToolName): boolean;
  toJSON(): string;
}

export interface ToolNameFactory {
  /** A valid toolName, or why the value is not one. */
  parse(raw: unknown): Result<ToolName>;
}
