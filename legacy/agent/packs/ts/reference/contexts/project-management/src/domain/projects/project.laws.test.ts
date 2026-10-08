// GENERATED from project.contract.ts by packs/ts/scripts/value-object-laws.ts — do not edit.
import { describe, expect, test } from "bun:test";
import type { Result } from "../shared/result.ts";
import { Project } from "./project.ts";
import { ProjectId } from "./project-id.ts";
import { ProjectName } from "./project-name.ts";

/** The value a parse produced, or a failure naming the refused example. A
 *  throwing skeleton never reaches this line: its NotImplementedError
 *  propagates first, which is what the red gate looks for. */
function mustParse<T>(result: Result<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} was refused: ${String(result.error)}`);
  return result.value;
}

describe("Project — entity laws (generated)", () => {
  test("equals compares by identity, not by content", () => {
    const id = ProjectId.generate();
    const name = mustParse(ProjectName.parse("Website relaunch"), "ProjectName.parse(\"Website relaunch\")");
    const a = new Project(id, name);
    const sameId = new Project(id, mustParse(ProjectName.parse("Office move"), "ProjectName.parse(\"Office move\")"));
    const otherId = new Project(ProjectId.generate(), name);
    expect(a.equals(a)).toBe(true);
    expect(a.equals(sameId)).toBe(true);
    expect(sameId.equals(a)).toBe(true);
    expect(a.equals(otherId)).toBe(false);
    expect(otherId.equals(a)).toBe(false);
  });

  test("toJSON is each field's own wire form", () => {
    const id = ProjectId.generate();
    const name = mustParse(ProjectName.parse("Website relaunch"), "ProjectName.parse(\"Website relaunch\")");
    const json = new Project(id, name).toJSON();
    expect(json.id).toStrictEqual(id.toJSON());
    expect(json.name).toStrictEqual(name.toJSON());
  });

  test("every id in toJSON parses back to the same identifier", () => {
    const id = ProjectId.generate();
    const name = mustParse(ProjectName.parse("Website relaunch"), "ProjectName.parse(\"Website relaunch\")");
    const json = new Project(id, name).toJSON();
    expect(mustParse(ProjectId.parse(json.id), "ProjectId.parse(json.id)").equals(id)).toBe(true);
  });
});
