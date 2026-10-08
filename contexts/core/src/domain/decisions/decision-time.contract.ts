import type { Result } from "../shared/result.ts";

/** The brand only DecisionTime itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const decisionTimeBrand: unique symbol;

/** When a decision was made: an ISO 8601 time in UTC, as `Date.prototype.toISOString` writes it. */
export interface DecisionTime {
  readonly __brand: "DecisionTime";
  readonly [decisionTimeBrand]: true;
  readonly value: string;
  equals(other: DecisionTime): boolean;
  toJSON(): string;
}

export interface DecisionTimeFactory {
  /** A decision time, or why the value is not one. Never throws. */
  parse(raw: unknown): Result<DecisionTime>;
}
