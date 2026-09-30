import { describe, expect, test } from "bun:test";
import { ProjectName } from "./project-name.ts";

describe("ProjectName", () => {
  test("parses a name and trims surrounding whitespace", () => {
    const name = ProjectName.parse("  Website redesign ");
    expect(name.ok && name.value.value).toBe("Website redesign");
  });

  test("refuses an empty or blank name with the reason", () => {
    expect(ProjectName.parse("")).toEqual({ ok: false, error: "Project name is required" });
    expect(ProjectName.parse(" \t ")).toEqual({ ok: false, error: "Project name is required" });
  });

  test("refuses anything that is not a string", () => {
    for (const raw of [undefined, null, 1, true, { name: "x" }]) expect(ProjectName.parse(raw).ok).toBe(false);
  });

  test("is equal by value and serialises to its string", () => {
    const a = ProjectName.parse("Mobile app");
    const b = ProjectName.parse("Mobile app");
    const c = ProjectName.parse("Q4 planning");
    if (!a.ok || !b.ok || !c.ok) throw new Error("expected valid names");
    expect(a.value.equals(b.value)).toBe(true);
    expect(a.value.equals(c.value)).toBe(false);
    expect(a.value.toJSON()).toBe("Mobile app");
  });
});
