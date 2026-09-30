import type { Note } from "@example/project-management/domain";
import type { ListNotes, ListNotesStore } from "./list-notes.contract.ts";

export class ListNotesHandler implements ListNotes {
  constructor(private readonly store: ListNotesStore) {}

  execute(): Promise<Note[]> {
    return this.store.findAll();
  }
}
