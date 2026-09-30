import { describe, expect, test } from "bun:test";
import { Project } from "./project.ts";
import { ProjectId } from "./project-id.ts";
import { ProjectName } from "./project-name.ts";

function name(raw: string): ProjectName {
  const parsed = ProjectName.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("Project", () => {
  test("holds the value objects it was built from", () => {
    const id = ProjectId.generate();
    const project = new Project(id, name("Mobile app"));
    expect(project.id.equals(id)).toBe(true);
    expect(project.name.value).toBe("Mobile app");
  });

  test("is equal by identity, whatever its name", () => {
    const id = ProjectId.generate();
    expect(new Project(id, name("Old")).equals(new Project(id, name("New")))).toBe(true);
    expect(new Project(ProjectId.generate(), name("Old")).equals(new Project(id, name("Old")))).toBe(false);
  });

  test("serialises to plain data", () => {
    const id = ProjectId.generate();
    expect(JSON.parse(JSON.stringify(new Project(id, name("Mobile app"))))).toEqual({ id: id.value, name: "Mobile app" });
  });
});
