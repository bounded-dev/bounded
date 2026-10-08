import type { CreateNoteStore } from "@example/project-management/application";
import type { Note, ProjectId } from "@example/project-management/domain";
import type { InMemoryDatabase } from "../in-memory-database.ts";

export class InMemoryCreateNoteStore implements CreateNoteStore {
  constructor(private readonly db: InMemoryDatabase) {}

  async projectExists(id: ProjectId): Promise<boolean> {
    return this.db.projects.some((project) => project.id.equals(id));
  }

  async save(note: Note): Promise<void> {
    this.db.notes.push(note);
  }
}
