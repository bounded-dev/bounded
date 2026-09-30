import { exportProjectsStoreConformance } from "../../../../application/projects/export-projects/export-projects.store.test-support.ts";
import { InMemoryDatabase } from "../in-memory-database.ts";
import { InMemoryExportProjectsStore } from "./export-projects.store.ts";

exportProjectsStoreConformance("InMemoryExportProjectsStore", async () => {
  const db = new InMemoryDatabase();
  return {
    store: new InMemoryExportProjectsStore(db),
    addProject: async (project) => {
      db.projects.push(project);
    },
  };
});
