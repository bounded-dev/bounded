import type { Result } from "../shared/result.ts";

/**
 * The name of a tagging scheme: a string that, once trimmed, is 1 to 80
 * characters long. The value is the trimmed string.
 * @accepts "Type"
 * @accepts "Liquidity"
 */
export interface TaggingSchemeName {
  readonly __brand: "TaggingSchemeName";
  readonly value: string;
  equals(other: TaggingSchemeName): boolean;
  toJSON(): string;
  /** Whether two names collide for uniqueness: equal once both are lower-cased. */
  clashesWith(other: TaggingSchemeName): boolean;
}

export interface TaggingSchemeNameFactory {
  parse(raw: unknown): Result<TaggingSchemeName>;
}
