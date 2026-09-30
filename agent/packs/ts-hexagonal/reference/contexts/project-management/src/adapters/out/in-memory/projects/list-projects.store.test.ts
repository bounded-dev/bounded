import { listProjectsStoreConformance } from "../../../../application/projects/list-projects/list-projects.store.test-support.ts";
import { InMemoryDatabase } from "../in-memory-database.ts";
import { InMemoryListProjectsStore } from "./list-projects.store.ts";

listProjectsStoreConformance("InMemoryListProjectsStore", async () => {
  const db = new InMemoryDatabase();
  return {
    store: new InMemoryListProjectsStore(db),
    addProject: async (project) => {
      db.projects.push(project);
    },
  };
});
