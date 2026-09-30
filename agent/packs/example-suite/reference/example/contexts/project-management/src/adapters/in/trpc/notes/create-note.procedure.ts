import { CreateNoteCommand, createNoteSchema, type CreateNote } from "@example/project-management/application";
import { t } from "../trpc.ts";

export const createNoteProcedure = (createNote: CreateNote) =>
  t.procedure.input(createNoteSchema).mutation(async ({ input }) => {
    const command = CreateNoteCommand.parse(input);
    if (!command.ok) return command;
    const result = await createNote.execute(command.value);
    return result.ok ? { ok: true as const, value: result.value.toJSON() } : result;
  });
