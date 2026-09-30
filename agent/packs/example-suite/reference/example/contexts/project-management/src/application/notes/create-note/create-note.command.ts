import { z } from "zod";
import { NoteText, ProjectId, type Result } from "@example/project-management/domain";
import type * as Contract from "./create-note.contract.ts";

// Wire contract: tRPC and MCP use this for their input types.
export const createNoteSchema = z.object({
  projectId: z.string(),
  text: z.string(),
}) satisfies z.ZodType<Contract.CreateNoteInput>;

class CreateNoteCommandImpl implements Contract.CreateNoteCommand {
  declare readonly __brand: "CreateNoteCommand";
  private constructor(
    readonly projectId: ProjectId,
    readonly text: NoteText,
  ) {}

  static parse(raw: unknown): Result<CreateNoteCommand> {
    const input = createNoteSchema.safeParse(raw);
    if (!input.success) return { ok: false, error: "Invalid create note input" };
    const projectId = ProjectId.parse(input.data.projectId);
    if (!projectId.ok) return projectId;
    const text = NoteText.parse(input.data.text);
    return text.ok ? { ok: true, value: new CreateNoteCommandImpl(projectId.value, text.value) } : text;
  }
}

export type CreateNoteCommand = Contract.CreateNoteCommand;
export const CreateNoteCommand: Contract.CreateNoteCommandFactory = CreateNoteCommandImpl;
