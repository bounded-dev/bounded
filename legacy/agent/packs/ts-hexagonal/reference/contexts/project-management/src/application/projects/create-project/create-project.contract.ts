import type { Project, ProjectName, Result } from "@example/project-management/domain";

// Wire input: what callers send.
export interface CreateProjectInput {
  readonly name: string;
}

// Command: the input once validated into value objects.
export interface CreateProjectCommand {
  readonly __brand: "CreateProjectCommand";
  readonly name: ProjectName;
}

export interface CreateProjectCommandFactory {
  parse(raw: unknown): Result<CreateProjectCommand>;
}

// In port: what this feature offers.
/**
 * Create a project
 * @exposedVia trpc mcp
 */
export interface CreateProject {
  execute(command: CreateProjectCommand): Promise<Project>;
}

// Out port: exactly what this feature needs.
export interface CreateProjectStore {
  save(project: Project): Promise<void>;
}
