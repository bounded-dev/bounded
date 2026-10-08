import type { Result } from "../shared/result.ts";

/**
 * The name of an account: a string that, once trimmed, is 1 to 80 characters
 * long. The value is the trimmed string. Names need not be unique.
 * @accepts "Joint current account"
 * @accepts "Family car"
 */
export interface AccountName {
  readonly __brand: "AccountName";
  readonly value: string;
  equals(other: AccountName): boolean;
  toJSON(): string;
}

export interface AccountNameFactory {
  parse(raw: unknown): Result<AccountName>;
}
