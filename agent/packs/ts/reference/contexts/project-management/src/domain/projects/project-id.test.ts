import { describe, expect, test } from "bun:test";
import { ProjectId } from "./project-id.ts";

// An identifier is a UUID: the generated laws cover generate/parse round
// trips; this names the wrong-value strings it must refuse.
describe("ProjectId — boundaries", () => {
  test("accepts a UUID", () => {
    expect(ProjectId.parse("7d0f4c2e-9b1a-4f6e-8c3d-2a5b6e7f8091").ok).toBe(true);
  });

  test("refuses a string that is not a UUID with the domain's reason", () => {
    expect(ProjectId.parse("project-1")).toEqual({ ok: false, error: "Invalid project id" });
  });

  test("refuses an empty string", () => {
    expect(ProjectId.parse("").ok).toBe(false);
  });
});
