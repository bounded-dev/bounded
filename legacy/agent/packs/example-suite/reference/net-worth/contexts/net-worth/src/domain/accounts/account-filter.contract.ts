import type { Result } from "../shared/result.ts";
import type { Tag } from "../tagging-schemes/tag.contract.ts";
import type { Account } from "./account.contract.ts";

/**
 * Which accounts a list shows: "" (every account) or criteria joined by ",",
 * each "kind:<asset|liability>", "tag:<tagId>" or "member:<memberId>"; an
 * account must meet every criterion. Parsing trims the input and each piece;
 * an empty piece, an unknown keyword or an argument that does not parse
 * (as AccountKind, TagId or MemberId) refuses the input. The value is the
 * distinct criteria in canonical form, sorted, joined by "," (TN-2,
 * "AccountFilter").
 * @accepts "kind:asset"
 * @accepts "kind:liability,member:2a9d6c1b-7e3f-4a5b-9c8d-1e2f3a4b5c6d"
 */
export interface AccountFilter {
  readonly __brand: "AccountFilter";
  readonly value: string;
  equals(other: AccountFilter): boolean;
  toJSON(): string;
  /**
   * Whether the account meets every criterion. A tag criterion looks its tag
   * up in `tags` (every tag of the workspace) and uses `account.hasTag`; a tag
   * not found there matches nothing.
   */
  matches(account: Account, tags: readonly Tag[]): boolean;
}

export interface AccountFilterFactory {
  parse(raw: unknown): Result<AccountFilter>;
}
