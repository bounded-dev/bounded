import type { Result } from "../shared/result.ts";

/**
 * A note's identity: a UUID.
 * @accepts "7c9e6679-7425-40de-944b-e07fc1f90ae7"
 * @accepts "16fd2706-8baf-433b-82eb-8c7fada847da"
 */
export interface NoteId {
  readonly __brand: "NoteId";
  readonly value: string;
  equals(other: NoteId): boolean;
  toJSON(): string;
}

export interface NoteIdFactory {
  generate(): NoteId;
  parse(raw: unknown): Result<NoteId>;
}
