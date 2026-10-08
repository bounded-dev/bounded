import { describe, expect, test } from "bun:test";
import { Project, ProjectId, ProjectName } from "@example/project-management/domain";
import type { ListProjectsStore } from "./list-projects.contract.ts";
import { ListProjectsHandler } from "./list-projects.handler.ts";

class FakeListProjectsStore implements ListProjectsStore {
  constructor(private readonly projects: readonly Project[]) {}

  async findAll(): Promise<Project[]> {
    return [...this.projects];
  }
}

function project(raw: string): Project {
  const name = ProjectName.parse(raw);
  if (!name.ok) throw new Error(name.error);
  return new Project(ProjectId.generate(), name.value);
}

describe("ListProjectsHandler", () => {
  test("lists every project the store holds, in its order", async () => {
    const projects = [project("One"), project("Two")];
    const listed = await new ListProjectsHandler(new FakeListProjectsStore(projects)).execute();
    expect(listed.map((p) => p.toJSON())).toEqual(projects.map((p) => p.toJSON()));
  });

  test("lists nothing when there are no projects", async () => {
    expect(await new ListProjectsHandler(new FakeListProjectsStore([])).execute()).toEqual([]);
  });
});
