import {
  CreateProjectCommand,
  createProjectSchema,
  type CreateProject,
} from "@example/project-management/application";
import { t } from "../trpc.ts";

export const createProjectProcedure = (createProject: CreateProject) =>
  t.procedure.input(createProjectSchema).mutation(async ({ input }) => {
    const command = CreateProjectCommand.parse(input);
    if (!command.ok) return command;
    const project = await createProject.execute(command.value);
    return { ok: true as const, value: project.toJSON() };
  });
