import type { ExportProjects } from "@example/project-management/application";

// Driving adapter: each scheduled invocation triggers one export.
export const createExportProjectsLambda = (exportProjects: ExportProjects) => async (): Promise<void> => {
  await exportProjects.execute();
};
