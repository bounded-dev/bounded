// Generated from create-note.contract.ts by the ts-hexagonal pack; do not edit.
// The laws every CreateNoteCommand obeys, whatever its value objects accept.
import { describe, expect, test } from "bun:test";
import { NoteText, ProjectId } from "@example/project-management/domain";
import { CreateNoteCommand } from "./create-note.command.ts";

const INVALID = { ok: false as const, error: "Invalid create note input" };
const STRINGS = ["", " ", "a", "Hello, world", "not-a-uuid", "00000000-0000-4000-8000-000000000000", "x".repeat(300)];

function wire(i: number, j: number): Record<string, unknown> {
  return {
    projectId: STRINGS[i % STRINGS.length],
    text: STRINGS[(i + j) % STRINGS.length],
  };
}

const cases = Array.from({ length: 49 }, (_, n) => wire(Math.floor(n / 7), n % 7));

describe("CreateNoteCommand laws", () => {
  test("refuses anything that is not an object", () => {
    for (const raw of [undefined, null, 0, 1, "", "text", true, [], [wire(0, 0)]]) {
      expect(CreateNoteCommand.parse(raw)).toEqual(INVALID);
    }
  });

  test("refuses input missing any field", () => {
    for (const field of ["projectId", "text"]) {
      const raw = wire(0, 0);
      delete raw[field];
      expect(CreateNoteCommand.parse(raw)).toEqual(INVALID);
    }
  });

  test("refuses a field of the wrong wire type", () => {
    expect(CreateNoteCommand.parse({ ...wire(0, 0), projectId: 42 })).toEqual(INVALID);
    expect(CreateNoteCommand.parse({ ...wire(0, 0), text: 42 })).toEqual(INVALID);
  });

  test("validates each field through its value object, in declaration order", () => {
    for (const raw of cases) {
      const result = CreateNoteCommand.parse(raw);
      const projectId = ProjectId.parse(raw.projectId);
      if (!projectId.ok) {
        expect(result).toEqual(projectId);
        continue;
      }
      const text = NoteText.parse(raw.text);
      if (!text.ok) {
        expect(result).toEqual(text);
        continue;
      }
      if (!result.ok) throw new Error(`expected ${JSON.stringify(raw)} to parse`);
      expect(result.value.projectId.equals(projectId.value)).toBe(true);
      expect(result.value.text.equals(text.value)).toBe(true);
    }
  });

  test("ignores fields the input does not declare", () => {
    for (const raw of cases) {
      const plain = JSON.stringify(CreateNoteCommand.parse(raw));
      expect(JSON.stringify(CreateNoteCommand.parse({ ...raw, undeclared: "x" }))).toBe(plain);
    }
  });
});
