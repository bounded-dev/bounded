import { describe, expect, test } from "bun:test";
import { NoteText } from "./note-text.ts";

describe("NoteText", () => {
  test("parses text and trims surrounding whitespace", () => {
    const text = NoteText.parse("  Buy milk  ");
    expect(text.ok && text.value.value).toBe("Buy milk");
  });

  test("refuses empty or blank text with the reason", () => {
    expect(NoteText.parse("")).toEqual({ ok: false, error: "Note text is required" });
    expect(NoteText.parse("   ")).toEqual({ ok: false, error: "Note text is required" });
  });

  test("refuses anything that is not a string", () => {
    for (const raw of [undefined, null, 42, {}, ["text"]]) expect(NoteText.parse(raw).ok).toBe(false);
  });

  test("is equal to another note text with the same value", () => {
    const a = NoteText.parse("Same");
    const b = NoteText.parse(" Same ");
    const c = NoteText.parse("Other");
    if (!a.ok || !b.ok || !c.ok) throw new Error("expected valid note texts");
    expect(a.value.equals(b.value)).toBe(true);
    expect(a.value.equals(c.value)).toBe(false);
  });

  test("serialises to its plain string", () => {
    const text = NoteText.parse("Buy milk");
    if (!text.ok) throw new Error(text.error);
    expect(JSON.stringify({ text: text.value })).toBe('{"text":"Buy milk"}');
  });
});
