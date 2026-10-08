import type { ProjectId } from "../projects/project-id.contract.ts";
import type * as Contract from "./note.contract.ts";
import type { NoteId } from "./note-id.contract.ts";
import type { NoteText } from "./note-text.contract.ts";

// Entity: built from already-valid value objects, equal by identity.
class NoteImpl implements Contract.Note {
  declare readonly __brand: "Note";
  constructor(
    readonly id: NoteId,
    readonly projectId: ProjectId,
    readonly text: NoteText,
  ) {}

  equals(other: Note): boolean {
    return this.id.equals(other.id);
  }

  toJSON(): { readonly id: string; readonly projectId: string; readonly text: string } {
    return { id: this.id.value, projectId: this.projectId.value, text: this.text.value };
  }
}

export type Note = Contract.Note;
export const Note: Contract.NoteFactory = NoteImpl;
