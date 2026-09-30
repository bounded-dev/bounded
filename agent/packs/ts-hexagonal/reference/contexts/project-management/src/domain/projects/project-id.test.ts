import { describe, expect, test } from "bun:test";
import { ProjectId } from "./project-id.ts";

const UUID = "0b9f5c2a-7d1e-4c3b-9a8f-6e5d4c3b2a19";

describe("ProjectId", () => {
  test("generates a different valid id each time", () => {
    const a = ProjectId.generate();
    const b = ProjectId.generate();
    expect(a.equals(b)).toBe(false);
    expect(ProjectId.parse(a.toJSON()).ok).toBe(true);
  });

  test("parses a UUID", () => {
    const id = ProjectId.parse(UUID);
    expect(id.ok && id.value.value).toBe(UUID);
  });

  test("refuses anything that is not a UUID with the reason", () => {
    expect(ProjectId.parse("project-1")).toEqual({ ok: false, error: "Invalid project id" });
    for (const raw of [undefined, null, 1, {}]) expect(ProjectId.parse(raw).ok).toBe(false);
  });

  test("is equal by value", () => {
    const a = ProjectId.parse(UUID);
    const b = ProjectId.parse(UUID);
    if (!a.ok || !b.ok) throw new Error("expected valid ids");
    expect(a.value.equals(b.value)).toBe(true);
    expect(a.value.equals(ProjectId.generate())).toBe(false);
  });
});
