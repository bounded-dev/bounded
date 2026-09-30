import type { Result } from "../shared/result.ts";

export interface NoteText {
  readonly __brand: "NoteText";
  readonly value: string;
  equals(other: NoteText): boolean;
  toJSON(): string;
}

export interface NoteTextFactory {
  parse(raw: unknown): Result<NoteText>;
}
