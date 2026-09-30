import type { ProjectId } from "../projects/project-id.contract.ts";
import type { NoteId } from "./note-id.contract.ts";
import type { NoteText } from "./note-text.contract.ts";

export interface Note {
  readonly __brand: "Note";
  readonly id: NoteId;
  readonly projectId: ProjectId;
  readonly text: NoteText;
  equals(other: Note): boolean;
  toJSON(): { readonly id: string; readonly projectId: string; readonly text: string };
}

export interface NoteFactory {
  new (id: NoteId, projectId: ProjectId, text: NoteText): Note;
}
