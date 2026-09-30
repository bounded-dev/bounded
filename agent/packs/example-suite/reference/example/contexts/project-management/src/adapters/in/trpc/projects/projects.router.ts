import type { CreateProject, ListProjects } from "@example/project-management/application";
import { t } from "../trpc.ts";
import { createProjectProcedure } from "./create-project.procedure.ts";
import { listProjectsProcedure } from "./list-projects.procedure.ts";

export function createProjectsRouter(deps: { createProject: CreateProject; listProjects: ListProjects }) {
  return t.router({
    create: createProjectProcedure(deps.createProject),
    list: listProjectsProcedure(deps.listProjects),
  });
}
