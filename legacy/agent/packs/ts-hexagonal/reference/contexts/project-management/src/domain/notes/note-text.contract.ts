import type { Result } from "../shared/result.ts";

/**
 * The text of a note: any string that is not empty once trimmed; stored trimmed.
 * @accepts "Call the printer"
 * @accepts "Book the venue"
 */
export interface NoteText {
  readonly __brand: "NoteText";
  readonly value: string;
  equals(other: NoteText): boolean;
  toJSON(): string;
}

export interface NoteTextFactory {
  parse(raw: unknown): Result<NoteText>;
}
