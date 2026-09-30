import { describe, expect, test } from "bun:test";
import { Project } from "./project.ts";
import { ProjectId } from "./project-id.ts";
import { ProjectName } from "./project-name.ts";

function name(raw: string): ProjectName {
  const result = ProjectName.parse(raw);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("Project", () => {
  test("renaming keeps the identity: same id, different name, still equal", () => {
    const id = ProjectId.generate();
    expect(new Project(id, name("Website relaunch")).equals(new Project(id, name("Office move")))).toBe(true);
  });

  test("toJSON is the wire shape callers receive", () => {
    const id = ProjectId.generate();
    expect(new Project(id, name("Office move")).toJSON()).toEqual({ id: id.value, name: "Office move" });
  });
});
