import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Project, ProjectId, ProjectName } from "@example/project-management/domain";
import { ConsoleProjectExporter } from "./export-projects.exporter.ts";

const table = spyOn(console, "table").mockImplementation(() => {});
afterEach(() => table.mockClear());

function project(raw: string): Project {
  const name = ProjectName.parse(raw);
  if (!name.ok) throw new Error(name.error);
  return new Project(ProjectId.generate(), name.value);
}

describe("ConsoleProjectExporter", () => {
  test("prints the projects as plain data, one table per export", async () => {
    const projects = [project("One"), project("Two")];
    await new ConsoleProjectExporter().export(projects);
    expect(table).toHaveBeenCalledTimes(1);
    expect(table).toHaveBeenCalledWith(projects.map((p) => p.toJSON()));
  });

  test("prints an empty table when there is nothing to export", async () => {
    await new ConsoleProjectExporter().export([]);
    expect(table).toHaveBeenCalledWith([]);
  });
});
