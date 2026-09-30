import type { Project } from "@example/project-management/domain";

// In port: what this feature offers.
/**
 * Export every project
 * @exposedVia lambda
 */
export interface ExportProjects {
  execute(): Promise<void>;
}

// Out ports: exactly what this feature needs.
export interface ExportProjectsStore {
  findAll(): Promise<Project[]>;
}

/** @implementedBy console */
export interface ProjectExporter {
  export(projects: Project[]): Promise<void>;
}
