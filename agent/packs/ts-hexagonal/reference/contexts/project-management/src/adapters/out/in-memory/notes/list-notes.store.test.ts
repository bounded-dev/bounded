import { listNotesStoreConformance } from "../../../../application/notes/list-notes/list-notes.store.test-support.ts";
import { InMemoryDatabase } from "../in-memory-database.ts";
import { InMemoryCreateProjectStore } from "../projects/create-project.store.ts";
import { InMemoryCreateNoteStore } from "./create-note.store.ts";
import { InMemoryListNotesStore } from "./list-notes.store.ts";

// Seeded through the sibling stores that save projects and notes, never the
// database's fields.
listNotesStoreConformance("InMemoryListNotesStore", async () => {
  const db = new InMemoryDatabase();
  return {
    store: new InMemoryListNotesStore(db),
    addProject: (project) => new InMemoryCreateProjectStore(db).save(project),
    addNote: (note) => new InMemoryCreateNoteStore(db).save(note),
  };
});
