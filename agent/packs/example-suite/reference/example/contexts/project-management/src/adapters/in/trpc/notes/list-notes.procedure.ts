import type { ListNotes } from "@example/project-management/application";
import { t } from "../trpc.ts";

export const listNotesProcedure = (listNotes: ListNotes) =>
  t.procedure.query(async () => (await listNotes.execute()).map((note) => note.toJSON()));
