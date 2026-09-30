import { describe, expect, test } from "bun:test";
import { ProjectId } from "../projects/project-id.ts";
import { Note } from "./note.ts";
import { NoteId } from "./note-id.ts";
import { NoteText } from "./note-text.ts";

function text(raw: string): NoteText {
  const parsed = NoteText.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("Note", () => {
  test("holds the value objects it was built from", () => {
    const id = NoteId.generate();
    const projectId = ProjectId.generate();
    const note = new Note(id, projectId, text("Buy milk"));
    expect(note.id.equals(id)).toBe(true);
    expect(note.projectId.equals(projectId)).toBe(true);
    expect(note.text.value).toBe("Buy milk");
  });

  test("is equal by identity, whatever its contents", () => {
    const id = NoteId.generate();
    const projectId = ProjectId.generate();
    expect(new Note(id, projectId, text("One")).equals(new Note(id, projectId, text("Two")))).toBe(true);
    expect(new Note(NoteId.generate(), projectId, text("One")).equals(new Note(id, projectId, text("One")))).toBe(false);
  });

  test("serialises to plain data", () => {
    const id = NoteId.generate();
    const projectId = ProjectId.generate();
    expect(new Note(id, projectId, text("Buy milk")).toJSON()).toEqual({
      id: id.value,
      projectId: projectId.value,
      text: "Buy milk",
    });
  });
});
