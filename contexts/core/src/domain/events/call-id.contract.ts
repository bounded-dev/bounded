import type { Result } from "../shared/result.ts";

/** The host's id for one tool call: non-empty text without control characters, at most 256 characters. A tool result names the same id as its tool use. */
export interface CallId {
  readonly __brand: "CallId";
  readonly value: string;
  equals(other: CallId): boolean;
  toJSON(): string;
}

export interface CallIdFactory {
  /** A valid callId, or why the value is not one. */
  parse(raw: unknown): Result<CallId>;
}
