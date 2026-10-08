import type { Result } from "../shared/result.ts";

/**
 * An account's identity: a UUID (any version), matched case-insensitively and
 * held lower-cased. "account-1" and "" are refused.
 * @accepts "5f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f"
 * @accepts "b7c8d9e0-f1a2-4b3c-9d4e-5f6a7b8c9d0e"
 */
export interface AccountId {
  readonly __brand: "AccountId";
  readonly value: string;
  equals(other: AccountId): boolean;
  toJSON(): string;
}

export interface AccountIdFactory {
  generate(): AccountId;
  parse(raw: unknown): Result<AccountId>;
}
