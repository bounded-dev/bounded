import type { MemberId } from "../members/member-id.contract.ts";
import type { Result } from "../shared/result.ts";

/**
 * Who owns an account and in what percentage shares: one or more distinct
 * members whose shares, in hundredths of a percent, are each at least 0.01%
 * and sum to exactly 100.00%. Parsing takes either the explicit form,
 * "<memberId>:<share>" entries joined by "," (share: 1-3 digits, optionally
 * "." and 1-2 digits), or the even-split form, member ids only joined by ",",
 * which divides 100% evenly with the leftover hundredths going to the last
 * owners in member-id order (TN-2, "Ownership"). The value is the canonical
 * explicit form: ids lower-cased, sorted, shares with exactly two decimals,
 * joined by "," with no spaces.
 * @accepts "2a9d6c1b-7e3f-4a5b-9c8d-1e2f3a4b5c6d:100.00"
 * @accepts "2a9d6c1b-7e3f-4a5b-9c8d-1e2f3a4b5c6d:50.00,c4e8a2f6-1b3d-4e5f-8a7b-9c0d1e2f3a4b:50.00"
 */
export interface Ownership {
  readonly __brand: "Ownership";
  readonly value: string;
  equals(other: Ownership): boolean;
  toJSON(): string;
  /** Whether the member is one of the owners. */
  includes(memberId: MemberId): boolean;
  /** The owners, in value order. */
  memberIds(): readonly MemberId[];
}

export interface OwnershipFactory {
  parse(raw: unknown): Result<Ownership>;
}
