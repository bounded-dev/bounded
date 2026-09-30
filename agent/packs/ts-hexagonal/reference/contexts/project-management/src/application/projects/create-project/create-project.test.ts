import { describe, expect, test } from "bun:test";
import type { Project } from "@example/project-management/domain";
import { CreateProjectCommand } from "./create-project.command.ts";
import type { CreateProjectStore } from "./create-project.contract.ts";
import { CreateProjectHandler } from "./create-project.handler.ts";

class FakeCreateProjectStore implements CreateProjectStore {
  readonly saved: Project[] = [];

  async save(project: Project): Promise<void> {
    this.saved.push(project);
  }
}

function command(name: string): CreateProjectCommand {
  const parsed = CreateProjectCommand.parse({ name });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("CreateProjectHandler", () => {
  test("creates the project with the given name and saves it", async () => {
    const store = new FakeCreateProjectStore();
    const project = await new CreateProjectHandler(store).execute(command("Mobile app"));
    expect(project.name.value).toBe("Mobile app");
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]!.equals(project)).toBe(true);
  });

  test("gives every project a new identity", async () => {
    const handler = new CreateProjectHandler(new FakeCreateProjectStore());
    const first = await handler.execute(command("Same"));
    const second = await handler.execute(command("Same"));
    expect(first.equals(second)).toBe(false);
  });
});
