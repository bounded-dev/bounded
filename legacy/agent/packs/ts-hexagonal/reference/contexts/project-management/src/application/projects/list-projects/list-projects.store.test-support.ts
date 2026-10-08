import { describe, expect, test } from "bun:test";
import { Project, ProjectId, ProjectName } from "@example/project-management/domain";
import type { ListProjectsStore } from "./list-projects.contract.ts";

/** A fresh store, plus seeding the projects the port only reads. */
export interface ListProjectsStoreFixture {
  readonly store: ListProjectsStore;
  addProject(project: Project): Promise<void>;
}

function project(raw: string): Project {
  const name = ProjectName.parse(raw);
  if (!name.ok) throw new Error(name.error);
  return new Project(ProjectId.generate(), name.value);
}

/** The behaviour every ListProjectsStore must have, whatever stores the data. */
export function listProjectsStoreConformance(name: string, fixture: () => Promise<ListProjectsStoreFixture>): void {
  describe(`${name} conforms to ListProjectsStore`, () => {
    test("finds nothing in an empty store", async () => {
      const { store } = await fixture();
      expect(await store.findAll()).toEqual([]);
    });

    test("finds every stored project", async () => {
      const { store, addProject } = await fixture();
      const projects = [project("One"), project("Two"), project("Three")];
      for (const p of projects) await addProject(p);
      const found = (await store.findAll()).map((p) => p.toJSON());
      expect(found).toHaveLength(3);
      for (const p of projects) expect(found).toContainEqual(p.toJSON());
    });
  });
}
