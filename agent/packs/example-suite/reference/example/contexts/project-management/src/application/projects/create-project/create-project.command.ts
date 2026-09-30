import { z } from "zod";
import { ProjectName, type Result } from "@example/project-management/domain";
import type * as Contract from "./create-project.contract.ts";

// Wire contract: tRPC and MCP use this for their input types.
export const createProjectSchema = z.object({
  name: z.string(),
}) satisfies z.ZodType<Contract.CreateProjectInput>;

class CreateProjectCommandImpl implements Contract.CreateProjectCommand {
  declare readonly __brand: "CreateProjectCommand";
  private constructor(readonly name: ProjectName) {}

  static parse(raw: unknown): Result<CreateProjectCommand> {
    const input = createProjectSchema.safeParse(raw);
    if (!input.success) return { ok: false, error: "Invalid create project input" };
    const name = ProjectName.parse(input.data.name);
    return name.ok ? { ok: true, value: new CreateProjectCommandImpl(name.value) } : name;
  }
}

export type CreateProjectCommand = Contract.CreateProjectCommand;
export const CreateProjectCommand: Contract.CreateProjectCommandFactory = CreateProjectCommandImpl;
