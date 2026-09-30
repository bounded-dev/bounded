import { listNotesStoreConformance } from "../../../../application/notes/list-notes/list-notes.store.test-support.ts";
import { InMemoryDatabase } from "../in-memory-database.ts";
import { InMemoryListNotesStore } from "./list-notes.store.ts";

listNotesStoreConformance("InMemoryListNotesStore", async () => {
  const db = new InMemoryDatabase();
  return {
    store: new InMemoryListNotesStore(db),
    addNote: async (note) => {
      db.notes.push(note);
    },
  };
});
