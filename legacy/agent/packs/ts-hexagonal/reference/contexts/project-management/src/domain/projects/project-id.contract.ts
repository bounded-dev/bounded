import type { Result } from "../shared/result.ts";

/**
 * A project's identity: a UUID.
 * @accepts "3b241101-e2bb-4255-8caf-4136c566a962"
 * @accepts "9b2f5c1e-0d7a-4a43-9f3e-2c1d8e6b7a50"
 */
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
