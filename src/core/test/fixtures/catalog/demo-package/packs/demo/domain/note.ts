import { point, type Result } from "bounded/domain";
import type * as Contract from "./note.contract.ts";

class NoteImpl implements Contract.Note {
  declare readonly __brand: "Note";

  private constructor(readonly text: string) {
    Object.freeze(this);
  }

  static parse(raw: unknown): Result<Contract.Note> {
    const given: unknown = raw instanceof NoteImpl ? raw.toJSON() : raw;
    if (typeof given !== "object" || given === null || !("text" in given) || typeof given.text !== "string" || given.text.trim() === "") return { ok: false, error: "A note is { text }: a line of text" };
    return { ok: true, value: new NoteImpl(given.text.trim()) };
  }

  equals(other: Contract.Note): boolean {
    return other.text === this.text;
  }

  toJSON(): Contract.NoteJSON {
    return { text: this.text };
  }
}

export type Note = Contract.Note;
export const Note: Contract.NoteFactory = NoteImpl;

/** The demonstration pack's one point: notes a project keeps. */
export const notesPoint = point({ description: "Notes a project keeps for its agents", check: Note.parse });
