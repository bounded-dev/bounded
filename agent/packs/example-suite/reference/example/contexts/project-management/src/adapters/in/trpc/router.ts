import { createNotesRouter } from "./notes/notes.router.ts";
import { createProjectsRouter } from "./projects/projects.router.ts";
import { t } from "./trpc.ts";

type Deps = Parameters<typeof createNotesRouter>[0] & Parameters<typeof createProjectsRouter>[0];

// The whole context's API: notes.* and projects.*
export function createProjectManagementRouter(deps: Deps) {
  return t.router({
    notes: createNotesRouter(deps),
    projects: createProjectsRouter(deps),
  });
}

export type ProjectManagementRouter = ReturnType<typeof createProjectManagementRouter>;
