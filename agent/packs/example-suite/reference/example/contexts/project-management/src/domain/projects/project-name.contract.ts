import type { Result } from "../shared/result.ts";

export interface ProjectName {
  readonly __brand: "ProjectName";
  readonly value: string;
  equals(other: ProjectName): boolean;
  toJSON(): string;
}

export interface ProjectNameFactory {
  parse(raw: unknown): Result<ProjectName>;
}
