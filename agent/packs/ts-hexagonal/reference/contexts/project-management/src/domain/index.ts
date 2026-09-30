export type { Result } from "./shared/result.ts";

// Each export is both the contract type and its implementation value.
export type { NoteFactory } from "./notes/note.contract.ts";
export type { NoteIdFactory } from "./notes/note-id.contract.ts";
export type { NoteTextFactory } from "./notes/note-text.contract.ts";
export { Note } from "./notes/note.ts";
export { NoteId } from "./notes/note-id.ts";
export { NoteText } from "./notes/note-text.ts";

export type { ProjectFactory } from "./projects/project.contract.ts";
export type { ProjectIdFactory } from "./projects/project-id.contract.ts";
export type { ProjectNameFactory } from "./projects/project-name.contract.ts";
export { Project } from "./projects/project.ts";
export { ProjectId } from "./projects/project-id.ts";
export { ProjectName } from "./projects/project-name.ts";
