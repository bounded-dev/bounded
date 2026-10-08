import type { CreateProjectStore } from "@example/project-management/application";
import type { Project } from "@example/project-management/domain";
import type { InMemoryDatabase } from "../in-memory-database.ts";

export class InMemoryCreateProjectStore implements CreateProjectStore {
  constructor(private readonly db: InMemoryDatabase) {}

  async save(project: Project): Promise<void> {
    this.db.projects.push(project);
  }
}
