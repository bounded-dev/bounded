import { describe, expect, test } from "bun:test";
import { NoteText } from "./note-text.ts";

// The domain rule the generated laws cannot know: which strings are note text.
describe("NoteText — boundaries", () => {
  test("accepts text and stores it trimmed", () => {
    const result = NoteText.parse("  Call the printer  ");
    expect(result.ok && result.value.value).toBe("Call the printer");
  });

  test("refuses an empty string with the domain's reason", () => {
    expect(NoteText.parse("")).toEqual({ ok: false, error: "Note text is required" });
  });

  test("refuses whitespace only", () => {
    expect(NoteText.parse(" \t\n ").ok).toBe(false);
  });

  test("two texts that trim to the same value are equal", () => {
    const a = NoteText.parse("Book the venue");
    const b = NoteText.parse(" Book the venue ");
    expect(a.ok && b.ok && a.value.equals(b.value)).toBe(true);
  });
});
