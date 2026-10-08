import type { Result } from "../shared/result.ts";
import type { TaggingSchemeId } from "../tagging-schemes/tagging-scheme-id.contract.ts";
import type { TagId } from "../tagging-schemes/tag-id.contract.ts";

/**
 * The tag an account carries in each tagging scheme: "" (no entries) or
 * entries "<taggingSchemeId>:<tagId>" joined by ",". Parsing trims the input
 * and each piece; an empty piece, a piece without exactly one ":", an id that
 * is not a UUID, or two entries for the same scheme refuses the input. The
 * value is the canonical form: ids lower-cased, entries sorted by scheme id,
 * joined by "," with no spaces (TN-2, "AccountTags").
 * @accepts "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5:9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d"
 * @accepts "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d:2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e,7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b:3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f"
 */
export interface AccountTags {
  readonly __brand: "AccountTags";
  readonly value: string;
  equals(other: AccountTags): boolean;
  toJSON(): string;
  /** The tag chosen in the scheme, or undefined when there is no entry for it. */
  tagIn(taggingSchemeId: TaggingSchemeId): TagId | undefined;
  /** The schemes that have an entry, in value order. */
  schemeIds(): readonly TaggingSchemeId[];
}

export interface AccountTagsFactory {
  parse(raw: unknown): Result<AccountTags>;
}
