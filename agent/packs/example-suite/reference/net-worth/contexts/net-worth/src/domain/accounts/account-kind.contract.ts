import type { Result } from "../shared/result.ts";

/**
 * Whether an account is something the household has or something it owes.
 * Parsing takes a string, trims it and lower-cases it; the result must be
 * exactly "asset" or "liability". "Asset" parses to "asset"; "debt" and ""
 * are refused. Amounts are always recorded as non-negative numbers; the kind
 * decides the sign in totals.
 * @accepts "asset"
 * @accepts "liability"
 */
export interface AccountKind {
  readonly __brand: "AccountKind";
  readonly value: string;
  equals(other: AccountKind): boolean;
  toJSON(): string;
  /** Whether this is "liability". */
  isLiability(): boolean;
}

export interface AccountKindFactory {
  parse(raw: unknown): Result<AccountKind>;
}
