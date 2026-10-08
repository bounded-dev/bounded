import type { ListProjects } from "@example/project-management/application";
import { t } from "../trpc.ts";

export const listProjectsProcedure = (listProjects: ListProjects) =>
  t.procedure.query(async () => (await listProjects.execute()).map((project) => project.toJSON()));
