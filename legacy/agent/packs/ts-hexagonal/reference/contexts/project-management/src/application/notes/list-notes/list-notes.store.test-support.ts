import { describe, expect, test } from "bun:test";
import { Note, NoteId, NoteText, Project, ProjectId, ProjectName } from "@example/project-management/domain";
import type { ListNotesStore } from "./list-notes.contract.ts";

/** A fresh store, plus seeding what the port only reads: the notes, and the
 *  project each one belongs to (a note always belongs to a stored project). */
export interface ListNotesStoreFixture {
  readonly store: ListNotesStore;
  addProject(project: Project): Promise<void>;
  addNote(note: Note): Promise<void>;
}

function project(): Project {
  const name = ProjectName.parse("Website redesign");
  if (!name.ok) throw new Error(name.error);
  return new Project(ProjectId.generate(), name.value);
}

function note(projectId: ProjectId, raw: string): Note {
  const text = NoteText.parse(raw);
  if (!text.ok) throw new Error(text.error);
  return new Note(NoteId.generate(), projectId, text.value);
}

/** The behaviour every ListNotesStore must have, whatever stores the data. */
export function listNotesStoreConformance(name: string, fixture: () => Promise<ListNotesStoreFixture>): void {
  describe(`${name} conforms to ListNotesStore`, () => {
    test("finds nothing in an empty store", async () => {
      const { store } = await fixture();
      expect(await store.findAll()).toEqual([]);
    });

    test("finds every stored note", async () => {
      const { store, addProject, addNote } = await fixture();
      const owner = project();
      await addProject(owner);
      const notes = [note(owner.id, "First"), note(owner.id, "Second")];
      for (const n of notes) await addNote(n);
      const found = (await store.findAll()).map((n) => n.toJSON());
      expect(found).toHaveLength(2);
      for (const n of notes) expect(found).toContainEqual(n.toJSON());
    });
  });
}
