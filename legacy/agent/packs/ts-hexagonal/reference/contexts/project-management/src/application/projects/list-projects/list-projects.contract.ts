import type { Project } from "@example/project-management/domain";

// In port: what this feature offers.
/**
 * List all projects
 * @exposedVia trpc mcp
 */
export interface ListProjects {
  execute(): Promise<Project[]>;
}

// Out port: exactly what this feature needs.
export interface ListProjectsStore {
  findAll(): Promise<Project[]>;
}
