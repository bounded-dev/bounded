// Generated from the design (ADR 2026-066); do not edit: the design gate regenerates it.
// The one place that decides which adapter backs which port.
import {
  InMemoryCreateNoteStore,
  InMemoryCreateProjectStore,
  InMemoryDatabase,
  InMemoryListNotesStore,
  InMemoryListProjectsStore,
} from "@example/project-management/adapters/in-memory";
import { createProjectManagementRouter, type ProjectManagementRouter } from "@example/project-management/adapters/trpc";
import {
  CreateNoteHandler,
  CreateProjectHandler,
  ListNotesHandler,
  ListProjectsHandler,
} from "@example/project-management/application";

export function composeApp(): ProjectManagementRouter {
  const db = new InMemoryDatabase();

  return createProjectManagementRouter({
    notes: {
      create: new CreateNoteHandler(new InMemoryCreateNoteStore(db)),
      list: new ListNotesHandler(new InMemoryListNotesStore(db)),
    },
    projects: {
      create: new CreateProjectHandler(new InMemoryCreateProjectStore(db)),
      list: new ListProjectsHandler(new InMemoryListProjectsStore(db)),
    },
  });
}
