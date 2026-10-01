import { exportProjectsStoreConformance } from "../../../../application/projects/export-projects/export-projects.store.test-support.ts";
import { InMemoryDatabase } from "../in-memory-database.ts";
import { InMemoryCreateProjectStore } from "./create-project.store.ts";
import { InMemoryExportProjectsStore } from "./export-projects.store.ts";

// Seeded through the sibling store that saves projects, never the database's fields.
exportProjectsStoreConformance("InMemoryExportProjectsStore", async () => {
  const db = new InMemoryDatabase();
  return {
    store: new InMemoryExportProjectsStore(db),
    addProject: (project) => new InMemoryCreateProjectStore(db).save(project),
  };
});
