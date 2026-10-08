import { Project, ProjectId } from "@example/project-management/domain";
import type { CreateProject, CreateProjectCommand, CreateProjectStore } from "./create-project.contract.ts";

export class CreateProjectHandler implements CreateProject {
  constructor(private readonly store: CreateProjectStore) {}

  async execute(command: CreateProjectCommand): Promise<Project> {
    const project = new Project(ProjectId.generate(), command.name);
    await this.store.save(project);
    return project;
  }
}
