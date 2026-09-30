// GENERATED from note.contract.ts by packs/ts/scripts/value-object-laws.ts — do not edit.
import { describe, expect, test } from "bun:test";
import { ProjectId } from "../projects/project-id.ts";
import type { Result } from "../shared/result.ts";
import { Note } from "./note.ts";
import { NoteId } from "./note-id.ts";
import { NoteText } from "./note-text.ts";

/** The value a parse produced, or a failure naming the refused example. A
 *  throwing skeleton never reaches this line: its NotImplementedError
 *  propagates first, which is what the red gate looks for. */
function mustParse<T>(result: Result<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} was refused: ${String(result.error)}`);
  return result.value;
}

describe("Note — entity laws (generated)", () => {
  test("equals compares by identity, not by content", () => {
    const id = NoteId.generate();
    const projectId = ProjectId.generate();
    const text = mustParse(NoteText.parse("Call the printer"), "NoteText.parse(\"Call the printer\")");
    const a = new Note(id, projectId, text);
    const sameId = new Note(id, ProjectId.generate(), mustParse(NoteText.parse("Book the venue"), "NoteText.parse(\"Book the venue\")"));
    const otherId = new Note(NoteId.generate(), projectId, text);
    expect(a.equals(a)).toBe(true);
    expect(a.equals(sameId)).toBe(true);
    expect(sameId.equals(a)).toBe(true);
    expect(a.equals(otherId)).toBe(false);
    expect(otherId.equals(a)).toBe(false);
  });

  test("toJSON is each field's own wire form", () => {
    const id = NoteId.generate();
    const projectId = ProjectId.generate();
    const text = mustParse(NoteText.parse("Call the printer"), "NoteText.parse(\"Call the printer\")");
    const json = new Note(id, projectId, text).toJSON();
    expect(json.id).toStrictEqual(id.toJSON());
    expect(json.projectId).toStrictEqual(projectId.toJSON());
    expect(json.text).toStrictEqual(text.toJSON());
  });

  test("every id in toJSON parses back to the same identifier", () => {
    const id = NoteId.generate();
    const projectId = ProjectId.generate();
    const text = mustParse(NoteText.parse("Call the printer"), "NoteText.parse(\"Call the printer\")");
    const json = new Note(id, projectId, text).toJSON();
    expect(mustParse(NoteId.parse(json.id), "NoteId.parse(json.id)").equals(id)).toBe(true);
    expect(mustParse(ProjectId.parse(json.projectId), "ProjectId.parse(json.projectId)").equals(projectId)).toBe(true);
  });
});
