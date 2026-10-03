import type { Result } from "../shared/result.ts";

/**
 * The institution an account is held with (e.g. "Vanguard", "Monzo"), or no
 * provider at all. Parsing takes a string and trims it; the trimmed string must
 * be 0 to 80 characters long. The value is the trimmed string, and the empty
 * string means "no provider".
 * @accepts "Vanguard"
 * @accepts "Halifax"
 */
export interface Provider {
  readonly __brand: "Provider";
  readonly value: string;
  equals(other: Provider): boolean;
  toJSON(): string;
  /** Whether a provider was given: the value is not empty. */
  isGiven(): boolean;
  /** Whether two providers are the same institution: equal once both are lower-cased. */
  clashesWith(other: Provider): boolean;
}

export interface ProviderFactory {
  parse(raw: unknown): Result<Provider>;
}
