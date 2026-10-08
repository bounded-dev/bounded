import { createNoteStoreConformance } from "../../../../application/notes/create-note/create-note.store.test-support.ts";
import { InMemoryDatabase } from "../in-memory-database.ts";
import { InMemoryCreateProjectStore } from "../projects/create-project.store.ts";
import { InMemoryCreateNoteStore } from "./create-note.store.ts";
import { InMemoryListNotesStore } from "./list-notes.store.ts";

// The database's fields are the builder's; the test seeds and reads back
// through the context's sibling stores over the same database.
createNoteStoreConformance("InMemoryCreateNoteStore", async () => {
  const db = new InMemoryDatabase();
  return {
    store: new InMemoryCreateNoteStore(db),
    addProject: (project) => new InMemoryCreateProjectStore(db).save(project),
    savedNotes: () => new InMemoryListNotesStore(db).findAll(),
  };
});
