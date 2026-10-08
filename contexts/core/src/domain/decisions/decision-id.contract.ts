import type { Result } from "../shared/result.ts";

/** A decision's id: non-empty text without control characters, at most 256 characters. A follow-up record keeps its decision's id. */
export interface DecisionId {
  readonly __brand: "DecisionId";
  readonly value: string;
  equals(other: DecisionId): boolean;
  toJSON(): string;
}

export interface DecisionIdFactory {
  /** A valid decision id, or why the value is not one. */
  parse(raw: unknown): Result<DecisionId>;
}
