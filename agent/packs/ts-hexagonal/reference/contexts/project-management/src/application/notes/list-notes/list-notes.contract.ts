import type { Note } from "@example/project-management/domain";

// In port: what this feature offers.
/**
 * List all notes
 * @exposedVia trpc
 */
export interface ListNotes {
  execute(): Promise<Note[]>;
}

// Out port: exactly what this feature needs.
export interface ListNotesStore {
  findAll(): Promise<Note[]>;
}
