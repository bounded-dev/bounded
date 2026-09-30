import type { Project } from "@example/project-management/domain";
import type { ListProjects, ListProjectsStore } from "./list-projects.contract.ts";

export class ListProjectsHandler implements ListProjects {
  constructor(private readonly store: ListProjectsStore) {}

  execute(): Promise<Project[]> {
    return this.store.findAll();
  }
}
