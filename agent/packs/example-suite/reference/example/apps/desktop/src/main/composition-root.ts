import {
  CreateNoteHandler,
  CreateProjectHandler,
  ListNotesHandler,
  ListProjectsHandler,
} from "@example/project-management/application";
import { createProjectManagementRouter } from "@example/project-management/adapters/trpc";
import {
  InMemoryCreateNoteStore,
  InMemoryCreateProjectStore,
  InMemoryDatabase,
  InMemoryListNotesStore,
  InMemoryListProjectsStore,
} from "@example/project-management/adapters/in-memory";

// The one place that decides which adapter backs which port.
export function composeApp() {
  const db = new InMemoryDatabase();

  return createProjectManagementRouter({
    createNote: new CreateNoteHandler(new InMemoryCreateNoteStore(db)),
    listNotes: new ListNotesHandler(new InMemoryListNotesStore(db)),
    createProject: new CreateProjectHandler(new InMemoryCreateProjectStore(db)),
    listProjects: new ListProjectsHandler(new InMemoryListProjectsStore(db)),
  });
}
