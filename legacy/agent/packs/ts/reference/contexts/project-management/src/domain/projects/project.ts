import type * as Contract from "./project.contract.ts";
import type { ProjectId } from "./project-id.contract.ts";
import type { ProjectName } from "./project-name.contract.ts";

// Entity: built from already-valid value objects, equal by identity.
class ProjectImpl implements Contract.Project {
  declare readonly __brand: "Project";
  constructor(
    readonly id: ProjectId,
    readonly name: ProjectName,
  ) {}

  equals(other: Project): boolean {
    return this.id.equals(other.id);
  }

  toJSON(): { readonly id: string; readonly name: string } {
    return { id: this.id.value, name: this.name.value };
  }
}

export type Project = Contract.Project;
export const Project: Contract.ProjectFactory = ProjectImpl;
