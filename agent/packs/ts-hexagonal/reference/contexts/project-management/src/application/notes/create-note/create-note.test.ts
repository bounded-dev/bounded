import { describe, expect, test } from "bun:test";
import { Note, ProjectId } from "@example/project-management/domain";
import { CreateNoteCommand } from "./create-note.command.ts";
import type { CreateNoteStore } from "./create-note.contract.ts";
import { CreateNoteHandler } from "./create-note.handler.ts";

// A fake of this feature's own out port: only what create-note needs.
class FakeCreateNoteStore implements CreateNoteStore {
  readonly saved: Note[] = [];

  constructor(private readonly projects: readonly ProjectId[]) {}

  async projectExists(id: ProjectId): Promise<boolean> {
    return this.projects.some((project) => project.equals(id));
  }

  async save(note: Note): Promise<void> {
    this.saved.push(note);
  }
}

function command(projectId: ProjectId, text: string): CreateNoteCommand {
  const parsed = CreateNoteCommand.parse({ projectId: projectId.value, text });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("CreateNoteHandler", () => {
  test("creates the note in an existing project and saves it", async () => {
    const projectId = ProjectId.generate();
    const store = new FakeCreateNoteStore([projectId]);
    const result = await new CreateNoteHandler(store).execute(command(projectId, "Buy milk"));
    if (!result.ok) throw new Error(result.error);
    expect(result.value.projectId.equals(projectId)).toBe(true);
    expect(result.value.text.value).toBe("Buy milk");
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.equals(result.value)).toBe(true);
  });

  test("refuses a project that does not exist and saves nothing", async () => {
    const store = new FakeCreateNoteStore([]);
    const result = await new CreateNoteHandler(store).execute(command(ProjectId.generate(), "Buy milk"));
    expect(result).toEqual({ ok: false, error: "Project not found" });
    expect(store.saved).toEqual([]);
  });

  test("gives every note a new identity", async () => {
    const projectId = ProjectId.generate();
    const handler = new CreateNoteHandler(new FakeCreateNoteStore([projectId]));
    const first = await handler.execute(command(projectId, "Same"));
    const second = await handler.execute(command(projectId, "Same"));
    if (!first.ok || !second.ok) throw new Error("expected both notes to be created");
    expect(first.value.equals(second.value)).toBe(false);
  });
});
