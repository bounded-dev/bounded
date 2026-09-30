import { createProjectStoreConformance } from "../../../../application/projects/create-project/create-project.store.test-support.ts";
import { InMemoryDatabase } from "../in-memory-database.ts";
import { InMemoryCreateProjectStore } from "./create-project.store.ts";

createProjectStoreConformance("InMemoryCreateProjectStore", async () => {
  const db = new InMemoryDatabase();
  return {
    store: new InMemoryCreateProjectStore(db),
    savedProjects: async () => [...db.projects],
  };
});
