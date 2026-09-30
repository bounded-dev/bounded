import { describe, expect, test } from "bun:test";
import { Project, ProjectId, ProjectName } from "@example/project-management/domain";
import type { CreateProjectStore } from "./create-project.contract.ts";

/** A fresh store, plus reading back what the port only writes. */
export interface CreateProjectStoreFixture {
  readonly store: CreateProjectStore;
  savedProjects(): Promise<readonly Project[]>;
}

function project(raw: string): Project {
  const name = ProjectName.parse(raw);
  if (!name.ok) throw new Error(name.error);
  return new Project(ProjectId.generate(), name.value);
}

/** The behaviour every CreateProjectStore must have, whatever stores the data. */
export function createProjectStoreConformance(name: string, fixture: () => Promise<CreateProjectStoreFixture>): void {
  describe(`${name} conforms to CreateProjectStore`, () => {
    test("saves a project with everything it holds", async () => {
      const { store, savedProjects } = await fixture();
      const saved = project("Mobile app");
      await store.save(saved);
      const projects = await savedProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.toJSON()).toEqual(saved.toJSON());
    });

    test("keeps every project it saves", async () => {
      const { store, savedProjects } = await fixture();
      await store.save(project("One"));
      await store.save(project("Two"));
      expect((await savedProjects()).map((p) => p.name.value).sort()).toEqual(["One", "Two"]);
    });
  });
}
