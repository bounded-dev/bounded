import type { Note, Project } from "@example/project-management/domain";

// Shared data behind every in-memory store (later: a database connection).
export class InMemoryDatabase {
  readonly notes: Note[] = [];
  readonly projects: Project[] = [];
}
