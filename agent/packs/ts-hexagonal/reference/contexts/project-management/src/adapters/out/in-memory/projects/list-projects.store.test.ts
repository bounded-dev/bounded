import { listProjectsStoreConformance } from "../../../../application/projects/list-projects/list-projects.store.test-support.ts";
import { InMemoryDatabase } from "../in-memory-database.ts";
import { InMemoryCreateProjectStore } from "./create-project.store.ts";
import { InMemoryListProjectsStore } from "./list-projects.store.ts";

// Seeded through the sibling store that saves projects, never the database's fields.
listProjectsStoreConformance("InMemoryListProjectsStore", async () => {
  const db = new InMemoryDatabase();
  return {
    store: new InMemoryListProjectsStore(db),
    addProject: (project) => new InMemoryCreateProjectStore(db).save(project),
  };
});
