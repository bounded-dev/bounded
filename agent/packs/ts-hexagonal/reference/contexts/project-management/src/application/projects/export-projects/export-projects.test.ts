import { describe, expect, test } from "bun:test";
import { Project, ProjectId, ProjectName } from "@example/project-management/domain";
import type { ExportProjectsStore, ProjectExporter } from "./export-projects.contract.ts";
import { ExportProjectsHandler } from "./export-projects.handler.ts";

class FakeExportProjectsStore implements ExportProjectsStore {
  constructor(private readonly projects: readonly Project[]) {}

  async findAll(): Promise<Project[]> {
    return [...this.projects];
  }
}

class FakeProjectExporter implements ProjectExporter {
  readonly exports: Project[][] = [];

  async export(projects: Project[]): Promise<void> {
    this.exports.push(projects);
  }
}

function project(raw: string): Project {
  const name = ProjectName.parse(raw);
  if (!name.ok) throw new Error(name.error);
  return new Project(ProjectId.generate(), name.value);
}

describe("ExportProjectsHandler", () => {
  test("hands every stored project to the exporter, once", async () => {
    const projects = [project("One"), project("Two")];
    const exporter = new FakeProjectExporter();
    await new ExportProjectsHandler(new FakeExportProjectsStore(projects), exporter).execute();
    expect(exporter.exports).toHaveLength(1);
    expect(exporter.exports[0]!.map((p) => p.toJSON())).toEqual(projects.map((p) => p.toJSON()));
  });

  test("still exports when there are no projects", async () => {
    const exporter = new FakeProjectExporter();
    await new ExportProjectsHandler(new FakeExportProjectsStore([]), exporter).execute();
    expect(exporter.exports).toEqual([[]]);
  });
});
