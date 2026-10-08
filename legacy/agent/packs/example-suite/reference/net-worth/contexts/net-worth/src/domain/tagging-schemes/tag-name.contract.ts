import type { Result } from "../shared/result.ts";

/**
 * The name of a tag: a string that, once trimmed, is 1 to 80 characters long.
 * The value is the trimmed string.
 * @accepts "Property"
 * @accepts "Bank account"
 */
export interface TagName {
  readonly __brand: "TagName";
  readonly value: string;
  equals(other: TagName): boolean;
  toJSON(): string;
  /** Whether two names collide for uniqueness: equal once both are lower-cased. */
  clashesWith(other: TagName): boolean;
}

export interface TagNameFactory {
  parse(raw: unknown): Result<TagName>;
}
