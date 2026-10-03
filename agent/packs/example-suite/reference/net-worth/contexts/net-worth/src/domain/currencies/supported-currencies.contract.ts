import type { Result } from "../shared/result.ts";
import type { CurrencyCode } from "./currency-code.contract.ts";

/**
 * The set of currencies a workspace works in: one or more currency codes.
 * Parsing takes a string, splits it on ",", trims each piece and parses each
 * piece as a CurrencyCode; any piece that fails (an empty piece included)
 * refuses the whole input. Duplicates collapse. The value is the canonical
 * form: the distinct codes sorted ascending, joined by "," with no spaces
 * ("usd, gbp,USD" parses to "GBP,USD").
 * @accepts "GBP"
 * @accepts "EUR,GBP,USD"
 */
export interface SupportedCurrencies {
  readonly __brand: "SupportedCurrencies";
  readonly value: string;
  equals(other: SupportedCurrencies): boolean;
  toJSON(): string;
  /** Whether the code is one of the set. */
  includes(code: CurrencyCode): boolean;
}

export interface SupportedCurrenciesFactory {
  parse(raw: unknown): Result<SupportedCurrencies>;
}
