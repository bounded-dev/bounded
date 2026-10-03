import type { Result } from "../shared/result.ts";

/**
 * A tag's identity: a UUID (any version), matched case-insensitively and held
 * lower-cased. "tag-1" and "" are refused.
 * @accepts "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d"
 * @accepts "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5"
 */
export interface TagId {
  readonly __brand: "TagId";
  readonly value: string;
  equals(other: TagId): boolean;
  toJSON(): string;
}

export interface TagIdFactory {
  generate(): TagId;
  parse(raw: unknown): Result<TagId>;
}
