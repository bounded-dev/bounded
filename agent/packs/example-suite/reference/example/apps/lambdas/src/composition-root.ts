import { ExportProjectsHandler } from "@example/project-management/application";
import { createExportProjectsLambda } from "@example/project-management/adapters/lambda";
import { ConsoleProjectExporter } from "@example/project-management/adapters/console";
import { InMemoryDatabase, InMemoryExportProjectsStore } from "@example/project-management/adapters/in-memory";

// The one place that decides which adapter backs which port. One function per Lambda.
export function composeExportProjects() {
  const db = new InMemoryDatabase();

  return createExportProjectsLambda(
    new ExportProjectsHandler(new InMemoryExportProjectsStore(db), new ConsoleProjectExporter()),
  );
}
