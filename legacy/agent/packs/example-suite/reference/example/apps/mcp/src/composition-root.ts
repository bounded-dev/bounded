// Generated from the design (ADR LEG-2026-067); do not edit: the design gate regenerates it.
// The one place that decides which adapter backs which port.
import {
  InMemoryCreateProjectStore,
  InMemoryDatabase,
  InMemoryListProjectsStore,
} from "@example/project-management/adapters/in-memory";
import { createProjectManagementMcpServer } from "@example/project-management/adapters/mcp";
import { CreateProjectHandler, ListProjectsHandler } from "@example/project-management/application";

export function composeApp(): ReturnType<typeof createProjectManagementMcpServer> {
  const db = new InMemoryDatabase();

  return createProjectManagementMcpServer({
    projects: {
      create: new CreateProjectHandler(new InMemoryCreateProjectStore(db)),
      list: new ListProjectsHandler(new InMemoryListProjectsStore(db)),
    },
  });
}
