import type { CreateProject, ListProjects } from "@example/project-management/application";
import { t } from "../trpc.ts";
import { createProjectProcedure } from "./create-project.procedure.ts";
import { listProjectsProcedure } from "./list-projects.procedure.ts";

export function createProjectsRouter(deps: { create: CreateProject; list: ListProjects }) {
  return t.router({
    create: createProjectProcedure(deps.create),
    list: listProjectsProcedure(deps.list),
  });
}
