import { describe, expect, test } from "bun:test";
import { NoteId } from "./note-id.ts";

// An identifier is a UUID: the generated laws cover generate/parse round
// trips; this names the wrong-value strings it must refuse.
describe("NoteId — boundaries", () => {
  test("accepts a UUID", () => {
    expect(NoteId.parse("0b8e3f1a-2c4d-4e5f-9a6b-7c8d9e0f1a2b").ok).toBe(true);
  });

  test("refuses a string that is not a UUID with the domain's reason", () => {
    expect(NoteId.parse("note-1")).toEqual({ ok: false, error: "Invalid note id" });
  });

  test("refuses a UUID with a trailing character", () => {
    expect(NoteId.parse("0b8e3f1a-2c4d-4e5f-9a6b-7c8d9e0f1a2bx").ok).toBe(false);
  });
});
