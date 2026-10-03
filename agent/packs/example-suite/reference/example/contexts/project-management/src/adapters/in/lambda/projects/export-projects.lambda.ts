import type { ExportProjects } from "@example/project-management/application";

// Driving adapter: each invocation calls the in port once.
export const createExportProjectsLambda =
  (deps: { projects: { export: ExportProjects } }) =>
  async (): Promise<void> => {
    await deps.projects.export.execute();
  };
