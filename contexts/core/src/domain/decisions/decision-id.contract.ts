import type { Result } from "../shared/result.ts";

/** The brand only DecisionId itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const decisionIdBrand: unique symbol;

/** A decision's id: non-empty text without control characters, at most 256 characters. A follow-up record keeps its decision's id. */
export interface DecisionId {
  readonly __brand: "DecisionId";
  readonly [decisionIdBrand]: true;
  readonly value: string;
  equals(other: DecisionId): boolean;
  toJSON(): string;
}

export interface DecisionIdFactory {
  /** A valid decision id, or why the value is not one. */
  parse(raw: unknown): Result<DecisionId>;
}
