import type { CreateNote, ListNotes } from "@example/project-management/application";
import { t } from "../trpc.ts";
import { createNoteProcedure } from "./create-note.procedure.ts";
import { listNotesProcedure } from "./list-notes.procedure.ts";

export function createNotesRouter(deps: { createNote: CreateNote; listNotes: ListNotes }) {
  return t.router({
    create: createNoteProcedure(deps.createNote),
    list: listNotesProcedure(deps.listNotes),
  });
}
