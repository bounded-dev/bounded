import { CreateProjectHandler, ListProjectsHandler } from "@example/project-management/application";
import { createProjectManagementMcpServer } from "@example/project-management/adapters/mcp";
import {
  InMemoryCreateProjectStore,
  InMemoryDatabase,
  InMemoryListProjectsStore,
} from "@example/project-management/adapters/in-memory";

// The one place that decides which adapter backs which port.
export function composeApp() {
  const db = new InMemoryDatabase();

  return createProjectManagementMcpServer({
    createProject: new CreateProjectHandler(new InMemoryCreateProjectStore(db)),
    listProjects: new ListProjectsHandler(new InMemoryListProjectsStore(db)),
  });
}
