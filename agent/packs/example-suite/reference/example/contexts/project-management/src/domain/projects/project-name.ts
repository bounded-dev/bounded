import { z } from "zod";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./project-name.contract.ts";

const schema = z.string().trim().min(1, "Project name is required");

class ProjectNameImpl implements Contract.ProjectName {
  declare readonly __brand: "ProjectName";
  private constructor(readonly value: string) {}

  static parse(raw: unknown): Result<ProjectName> {
    const result = schema.safeParse(raw);
    return result.success
      ? { ok: true, value: new ProjectNameImpl(result.data) }
      : { ok: false, error: result.error.issues[0]?.message ?? "Invalid project name" };
  }

  equals(other: ProjectName): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type ProjectName = Contract.ProjectName;
export const ProjectName: Contract.ProjectNameFactory = ProjectNameImpl;
