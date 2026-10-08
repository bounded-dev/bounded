import type { Result } from "../shared/result.ts";

/** When a decision was made: an ISO 8601 time in UTC, as `Date.prototype.toISOString` writes it. */
export interface DecisionTime {
  readonly __brand: "DecisionTime";
  readonly value: string;
  equals(other: DecisionTime): boolean;
  toJSON(): string;
}

export interface DecisionTimeFactory {
  /** A decision time, or why the value is not one. Never throws. */
  parse(raw: unknown): Result<DecisionTime>;
}
