import { describe, expect, test } from "bun:test";
import { Project, ProjectId, ProjectName } from "@example/project-management/domain";
import type { ExportProjectsStore } from "./export-projects.contract.ts";

/** A fresh store, plus seeding the projects the port only reads. */
export interface ExportProjectsStoreFixture {
  readonly store: ExportProjectsStore;
  addProject(project: Project): Promise<void>;
}

function project(raw: string): Project {
  const name = ProjectName.parse(raw);
  if (!name.ok) throw new Error(name.error);
  return new Project(ProjectId.generate(), name.value);
}

/** The behaviour every ExportProjectsStore must have, whatever stores the data. */
export function exportProjectsStoreConformance(name: string, fixture: () => Promise<ExportProjectsStoreFixture>): void {
  describe(`${name} conforms to ExportProjectsStore`, () => {
    test("finds nothing in an empty store", async () => {
      const { store } = await fixture();
      expect(await store.findAll()).toEqual([]);
    });

    test("finds every stored project", async () => {
      const { store, addProject } = await fixture();
      const projects = [project("One"), project("Two")];
      for (const p of projects) await addProject(p);
      const found = (await store.findAll()).map((p) => p.toJSON());
      expect(found).toHaveLength(2);
      for (const p of projects) expect(found).toContainEqual(p.toJSON());
    });
  });
}
