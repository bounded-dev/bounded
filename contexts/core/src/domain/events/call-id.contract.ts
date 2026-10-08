import type { Result } from "../shared/result.ts";

/** The brand only CallId itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const callIdBrand: unique symbol;

/** The host's id for one tool call: non-empty text without control characters, at most 256 characters. A tool result names the same id as its tool use. */
export interface CallId {
  readonly __brand: "CallId";
  readonly [callIdBrand]: true;
  readonly value: string;
  equals(other: CallId): boolean;
  toJSON(): string;
}

export interface CallIdFactory {
  /** A valid callId, or why the value is not one. */
  parse(raw: unknown): Result<CallId>;
}
