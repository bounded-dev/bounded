import type { Result } from "bounded/domain";

/** A note's wire form: what a project writes, and what toJSON gives back. */
export interface NoteJSON {
  readonly text: string;
}

/** A note: one line of text a project keeps for its agents. */
export interface Note {
  readonly __brand: "Note";
  readonly text: string;
  equals(other: Note): boolean;
  toJSON(): NoteJSON;
}

export interface NoteFactory {
  /** A note, or why the value is not one. */
  parse(raw: unknown): Result<Note>;
}
