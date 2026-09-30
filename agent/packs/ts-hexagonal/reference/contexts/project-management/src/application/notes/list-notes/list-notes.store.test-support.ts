import { describe, expect, test } from "bun:test";
import { Note, NoteId, NoteText, ProjectId } from "@example/project-management/domain";
import type { ListNotesStore } from "./list-notes.contract.ts";

/** A fresh store, plus seeding the notes the port only reads. */
export interface ListNotesStoreFixture {
  readonly store: ListNotesStore;
  addNote(note: Note): Promise<void>;
}

function note(raw: string): Note {
  const text = NoteText.parse(raw);
  if (!text.ok) throw new Error(text.error);
  return new Note(NoteId.generate(), ProjectId.generate(), text.value);
}

/** The behaviour every ListNotesStore must have, whatever stores the data. */
export function listNotesStoreConformance(name: string, fixture: () => Promise<ListNotesStoreFixture>): void {
  describe(`${name} conforms to ListNotesStore`, () => {
    test("finds nothing in an empty store", async () => {
      const { store } = await fixture();
      expect(await store.findAll()).toEqual([]);
    });

    test("finds every stored note", async () => {
      const { store, addNote } = await fixture();
      const notes = [note("First"), note("Second")];
      for (const n of notes) await addNote(n);
      const found = (await store.findAll()).map((n) => n.toJSON());
      expect(found).toHaveLength(2);
      for (const n of notes) expect(found).toContainEqual(n.toJSON());
    });
  });
}
