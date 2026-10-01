import { createProjectStoreConformance } from "../../../../application/projects/create-project/create-project.store.test-support.ts";
import { InMemoryDatabase } from "../in-memory-database.ts";
import { InMemoryCreateProjectStore } from "./create-project.store.ts";
import { InMemoryListProjectsStore } from "./list-projects.store.ts";

// Read back through the sibling store that lists projects, never the database's fields.
createProjectStoreConformance("InMemoryCreateProjectStore", async () => {
  const db = new InMemoryDatabase();
  return {
    store: new InMemoryCreateProjectStore(db),
    savedProjects: () => new InMemoryListProjectsStore(db).findAll(),
  };
});
