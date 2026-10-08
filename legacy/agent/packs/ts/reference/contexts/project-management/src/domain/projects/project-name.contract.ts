import type { Result } from "../shared/result.ts";

/**
 * The name of a project: any string that is not empty once trimmed; stored trimmed.
 * @accepts "Website relaunch"
 * @accepts "Office move"
 */
export interface ProjectName {
  readonly __brand: "ProjectName";
  readonly value: string;
  equals(other: ProjectName): boolean;
  toJSON(): string;
}

export interface ProjectNameFactory {
  parse(raw: unknown): Result<ProjectName>;
}
