import type { Result } from "../shared/result.ts";

/**
 * A sum of money in some currency (the currency is held by whoever holds the
 * amount): a finite number from 0 to 999999999999.99 inclusive with at most
 * two decimal places, tested as Math.round(n * 100) / 100 === n. Liabilities
 * are recorded as positive amounts too. -0.01, 1.005, NaN and Infinity are
 * refused; 0 is accepted.
 * @accepts 1250.5
 * @accepts 0
 */
export interface Amount {
  readonly __brand: "Amount";
  readonly value: number;
  equals(other: Amount): boolean;
  toJSON(): number;
}

export interface AmountFactory {
  parse(raw: unknown): Result<Amount>;
}
