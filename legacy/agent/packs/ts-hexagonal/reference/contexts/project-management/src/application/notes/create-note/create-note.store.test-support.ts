import { describe, expect, test } from "bun:test";
import { Note, NoteId, NoteText, Project, ProjectId, ProjectName } from "@example/project-management/domain";
import type { CreateNoteStore } from "./create-note.contract.ts";

/** What each storage technology hands the suite: a fresh store, plus the two
 *  things the port itself cannot do, seeding a project and reading notes back. */
export interface CreateNoteStoreFixture {
  readonly store: CreateNoteStore;
  addProject(project: Project): Promise<void>;
  savedNotes(): Promise<readonly Note[]>;
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

/** The behaviour every CreateNoteStore must have, whatever stores the data. */
export function createNoteStoreConformance(name: string, fixture: () => Promise<CreateNoteStoreFixture>): void {
  describe(`${name} conforms to CreateNoteStore`, () => {
    test("a project it has never seen does not exist", async () => {
      const { store } = await fixture();
      expect(await store.projectExists(ProjectId.generate())).toBe(false);
    });

    test("a stored project exists", async () => {
      const { store, addProject } = await fixture();
      const existing = project();
      await addProject(existing);
      expect(await store.projectExists(existing.id)).toBe(true);
      expect(await store.projectExists(ProjectId.generate())).toBe(false);
    });

    test("saves a note with everything it holds", async () => {
      const { store, addProject, savedNotes } = await fixture();
      const existing = project();
      await addProject(existing);
      const saved = note(existing.id, "Buy milk");
      await store.save(saved);
      const notes = await savedNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0]?.toJSON()).toEqual(saved.toJSON());
    });
  });
}
