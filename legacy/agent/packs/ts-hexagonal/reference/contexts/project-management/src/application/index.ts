// Contracts are exported as types. Commands are exported from their implementation file (type and value together).
export type {
  CreateNote,
  CreateNoteCommandFactory,
  CreateNoteInput,
  CreateNoteStore,
} from "./notes/create-note/create-note.contract.ts";
export { CreateNoteCommand, createNoteSchema } from "./notes/create-note/create-note.command.ts";
export { CreateNoteHandler } from "./notes/create-note/create-note.handler.ts";

export type { ListNotes, ListNotesStore } from "./notes/list-notes/list-notes.contract.ts";
export { ListNotesHandler } from "./notes/list-notes/list-notes.handler.ts";

export type {
  CreateProject,
  CreateProjectCommandFactory,
  CreateProjectInput,
  CreateProjectStore,
} from "./projects/create-project/create-project.contract.ts";
export { CreateProjectCommand, createProjectSchema } from "./projects/create-project/create-project.command.ts";
export { CreateProjectHandler } from "./projects/create-project/create-project.handler.ts";

export type {
  ExportProjects,
  ExportProjectsStore,
  ProjectExporter,
} from "./projects/export-projects/export-projects.contract.ts";
export { ExportProjectsHandler } from "./projects/export-projects/export-projects.handler.ts";

export type { ListProjects, ListProjectsStore } from "./projects/list-projects/list-projects.contract.ts";
export { ListProjectsHandler } from "./projects/list-projects/list-projects.handler.ts";
