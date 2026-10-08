import type { Result } from "../shared/result.ts";

/**
 * A currency, by its ISO 4217 alphabetic code. Parsing trims the input and
 * upper-cases it; the result must then appear in the list of accepted codes in
 * TN-1 ("Currency codes"). "gbp" parses to "GBP"; "ABC", "XXX", "GB", "GBPX"
 * and "G1P" are refused.
 * @accepts "GBP"
 * @accepts "EUR"
 */
export interface CurrencyCode {
  readonly __brand: "CurrencyCode";
  readonly value: string;
  equals(other: CurrencyCode): boolean;
  toJSON(): string;
}

export interface CurrencyCodeFactory {
  parse(raw: unknown): Result<CurrencyCode>;
}
