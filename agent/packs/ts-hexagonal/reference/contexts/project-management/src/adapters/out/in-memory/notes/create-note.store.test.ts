import { createNoteStoreConformance } from "../../../../application/notes/create-note/create-note.store.test-support.ts";
import { InMemoryDatabase } from "../in-memory-database.ts";
import { InMemoryCreateNoteStore } from "./create-note.store.ts";

createNoteStoreConformance("InMemoryCreateNoteStore", async () => {
  const db = new InMemoryDatabase();
  return {
    store: new InMemoryCreateNoteStore(db),
    addProject: async (project) => {
      db.projects.push(project);
    },
    savedNotes: async () => [...db.notes],
  };
});
