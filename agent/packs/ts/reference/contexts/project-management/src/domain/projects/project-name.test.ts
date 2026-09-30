import { describe, expect, test } from "bun:test";
import { ProjectName } from "./project-name.ts";

// The domain rule the generated laws cannot know: which strings are project names.
describe("ProjectName — boundaries", () => {
  test("accepts a name and stores it trimmed", () => {
    const result = ProjectName.parse("  Website relaunch ");
    expect(result.ok && result.value.toJSON()).toBe("Website relaunch");
  });

  test("refuses an empty string with the domain's reason", () => {
    expect(ProjectName.parse("")).toEqual({ ok: false, error: "Project name is required" });
  });

  test("refuses whitespace only", () => {
    expect(ProjectName.parse("   ").ok).toBe(false);
  });
});
