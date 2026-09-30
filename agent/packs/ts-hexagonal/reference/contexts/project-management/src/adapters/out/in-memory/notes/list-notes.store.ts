import type { ListNotesStore } from "@example/project-management/application";
import type { Note } from "@example/project-management/domain";
import type { InMemoryDatabase } from "../in-memory-database.ts";

export class InMemoryListNotesStore implements ListNotesStore {
  constructor(private readonly db: InMemoryDatabase) {}

  async findAll(): Promise<Note[]> {
    return [...this.db.notes];
  }
}
