import type { Result } from "../shared/result.ts";

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
