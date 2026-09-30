import type { ProjectId } from "./project-id.contract.ts";
import type { ProjectName } from "./project-name.contract.ts";

export interface Project {
  readonly __brand: "Project";
  readonly id: ProjectId;
  readonly name: ProjectName;
  equals(other: Project): boolean;
  toJSON(): { readonly id: string; readonly name: string };
}

export interface ProjectFactory {
  new (id: ProjectId, name: ProjectName): Project;
}
