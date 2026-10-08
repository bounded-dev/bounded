// Generated from the design (ADR LEG-2026-067); do not edit: the design gate regenerates it.
// The one place that decides which adapter backs which port.
import { ConsoleProjectExporter } from "@example/project-management/adapters/console";
import { InMemoryDatabase, InMemoryExportProjectsStore } from "@example/project-management/adapters/in-memory";
import { createExportProjectsLambda } from "@example/project-management/adapters/lambda";
import { ExportProjectsHandler } from "@example/project-management/application";

export function composeExportProjects(): ReturnType<typeof createExportProjectsLambda> {
  const db = new InMemoryDatabase();

  return createExportProjectsLambda({
    projects: {
      export: new ExportProjectsHandler(new InMemoryExportProjectsStore(db), new ConsoleProjectExporter()),
    },
  });
}
