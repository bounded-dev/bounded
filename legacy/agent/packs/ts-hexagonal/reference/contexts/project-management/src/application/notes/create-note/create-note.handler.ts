import { Note, NoteId, type Result } from "@example/project-management/domain";
import type { CreateNote, CreateNoteCommand, CreateNoteStore } from "./create-note.contract.ts";

export class CreateNoteHandler implements CreateNote {
  constructor(private readonly store: CreateNoteStore) {}

  async execute(command: CreateNoteCommand): Promise<Result<Note>> {
    if (!(await this.store.projectExists(command.projectId))) {
      return { ok: false, error: "Project not found" };
    }
    const note = new Note(NoteId.generate(), command.projectId, command.text);
    await this.store.save(note);
    return { ok: true, value: note };
  }
}
