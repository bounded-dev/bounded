import { describe, expect, test } from "bun:test";
import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { Role } from "./role.ts";

valueObjectLaws("Role", Role, ["builder", "plan-reviewer"], ["", "Builder", "plan_reviewer", "a b", "a--b", "-a", "a-"]);

describe("Role — boundaries", () => {
  test("a role is its label: lowercase words joined by single hyphens", () => {
    expect<unknown>(Role.parse("plan-reviewer")).toEqual({ ok: true, value: "plan-reviewer" });
    expect<unknown>(Role.parse("agent-2")).toEqual({ ok: true, value: "agent-2" });
  });

  test("refuses anything else with a reason that names it and shows the form", () => {
    expect(Role.parse("Builder")).toEqual({ ok: false, error: "Role 'Builder' must be lowercase words joined by single hyphens, such as 'builder'" });
  });

  test("refuses a value that is not a string", () => {
    expect(Role.parse(1)).toEqual({ ok: false, error: "A role must be a string" });
  });
});
