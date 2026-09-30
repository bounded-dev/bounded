import { describe, expect, test } from "bun:test";
import { NoteId } from "./note-id.ts";

const UUID = "3f2b8c1e-4a5d-4e6f-8a7b-9c0d1e2f3a4b";

describe("NoteId", () => {
  test("generates a different valid id each time", () => {
    const a = NoteId.generate();
    const b = NoteId.generate();
    expect(a.equals(b)).toBe(false);
    expect(NoteId.parse(a.value).ok).toBe(true);
  });

  test("parses a UUID", () => {
    const id = NoteId.parse(UUID);
    expect(id.ok && id.value.value).toBe(UUID);
  });

  test("refuses anything that is not a UUID with the reason", () => {
    expect(NoteId.parse("not-a-uuid")).toEqual({ ok: false, error: "Invalid note id" });
    for (const raw of [undefined, null, 7, ""]) expect(NoteId.parse(raw).ok).toBe(false);
  });

  test("is equal by value and serialises to its string", () => {
    const a = NoteId.parse(UUID);
    const b = NoteId.parse(UUID);
    if (!a.ok || !b.ok) throw new Error("expected valid ids");
    expect(a.value.equals(b.value)).toBe(true);
    expect(a.value.toJSON()).toBe(UUID);
  });
});
