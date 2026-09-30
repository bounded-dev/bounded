import type { Result } from "../shared/result.ts";

export interface ProjectId {
  readonly __brand: "ProjectId";
  readonly value: string;
  equals(other: ProjectId): boolean;
  toJSON(): string;
}

export interface ProjectIdFactory {
  generate(): ProjectId;
  parse(raw: unknown): Result<ProjectId>;
}
