import type { Result } from "../shared/result.ts";

/**
 * A tagging scheme's identity: a UUID (any version), matched
 * case-insensitively and held lower-cased. "scheme-1" and "" are refused.
 * @accepts "5d3c1a2b-8e9f-4a0b-b1c2-d3e4f5a6b7c8"
 * @accepts "e1f2a3b4-c5d6-4e7f-8091-a2b3c4d5e6f7"
 */
export interface TaggingSchemeId {
  readonly __brand: "TaggingSchemeId";
  readonly value: string;
  equals(other: TaggingSchemeId): boolean;
  toJSON(): string;
}

export interface TaggingSchemeIdFactory {
  generate(): TaggingSchemeId;
  parse(raw: unknown): Result<TaggingSchemeId>;
}
