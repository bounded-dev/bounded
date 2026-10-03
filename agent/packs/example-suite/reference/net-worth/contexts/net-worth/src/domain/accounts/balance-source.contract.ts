import type { Result } from "../shared/result.ts";

/**
 * Where an account's balance comes from. "readings": it is entered in every
 * reading. "fixed": it has a set value (the opening balance, then any
 * revaluations) that does not change between readings, e.g. a car at a set
 * price. Parsing takes a string, trims it and lower-cases it; the result must
 * be exactly "readings" or "fixed". "Fixed" parses to "fixed"; "manual" and ""
 * are refused.
 * @accepts "readings"
 * @accepts "fixed"
 */
export interface BalanceSource {
  readonly __brand: "BalanceSource";
  readonly value: string;
  equals(other: BalanceSource): boolean;
  toJSON(): string;
  /** Whether this is "fixed". */
  isFixed(): boolean;
}

export interface BalanceSourceFactory {
  parse(raw: unknown): Result<BalanceSource>;
}
