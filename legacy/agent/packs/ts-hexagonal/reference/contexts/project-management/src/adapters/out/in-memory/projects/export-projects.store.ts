import type { ExportProjectsStore } from "@example/project-management/application";
import type { Project } from "@example/project-management/domain";
import type { InMemoryDatabase } from "../in-memory-database.ts";

export class InMemoryExportProjectsStore implements ExportProjectsStore {
  constructor(private readonly db: InMemoryDatabase) {}

  async findAll(): Promise<Project[]> {
    return [...this.db.projects];
  }
}
