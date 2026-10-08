import type { Note, NoteText, ProjectId, Result } from "@example/project-management/domain";

// Wire input: what callers send.
export interface CreateNoteInput {
  readonly projectId: string;
  readonly text: string;
}

// Command: the input once validated into value objects.
export interface CreateNoteCommand {
  readonly __brand: "CreateNoteCommand";
  readonly projectId: ProjectId;
  readonly text: NoteText;
}

export interface CreateNoteCommandFactory {
  parse(raw: unknown): Result<CreateNoteCommand>;
}

// In port: what this feature offers.
/**
 * Create a note in a project
 * @exposedVia trpc
 */
export interface CreateNote {
  execute(command: CreateNoteCommand): Promise<Result<Note>>;
}

// Out port: exactly what this feature needs.
export interface CreateNoteStore {
  projectExists(id: ProjectId): Promise<boolean>;
  save(note: Note): Promise<void>;
}
