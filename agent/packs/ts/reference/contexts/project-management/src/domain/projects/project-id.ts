import { z } from "zod";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./project-id.contract.ts";

const schema = z.uuid("Invalid project id");

class ProjectIdImpl implements Contract.ProjectId {
  declare readonly __brand: "ProjectId";
  private constructor(readonly value: string) {}

  static generate(): ProjectId {
    return new ProjectIdImpl(crypto.randomUUID());
  }

  static parse(raw: unknown): Result<ProjectId> {
    const result = schema.safeParse(raw);
    return result.success
      ? { ok: true, value: new ProjectIdImpl(result.data) }
      : { ok: false, error: result.error.issues[0]?.message ?? "Invalid project id" };
  }

  equals(other: ProjectId): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type ProjectId = Contract.ProjectId;
export const ProjectId: Contract.ProjectIdFactory = ProjectIdImpl;
