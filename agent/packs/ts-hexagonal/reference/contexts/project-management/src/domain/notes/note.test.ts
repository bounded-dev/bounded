import { describe, expect, test } from "bun:test";
import { ProjectId } from "../projects/project-id.ts";
import { Note } from "./note.ts";
import { NoteId } from "./note-id.ts";
import { NoteText } from "./note-text.ts";

function text(raw: string): NoteText {
  const result = NoteText.parse(raw);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("Note", () => {
  test("keeps the value objects it was built from", () => {
    const id = NoteId.generate();
    const projectId = ProjectId.generate();
    const note = new Note(id, projectId, text("Call the printer"));
    expect(note.id).toBe(id);
    expect(note.projectId).toBe(projectId);
    expect(note.text.value).toBe("Call the printer");
  });

  test("toJSON is the wire shape callers receive", () => {
    const id = NoteId.generate();
    const projectId = ProjectId.generate();
    expect(new Note(id, projectId, text("Book the venue")).toJSON()).toEqual({
      id: id.value,
      projectId: projectId.value,
      text: "Book the venue",
    });
  });
});
