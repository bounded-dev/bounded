// Inline copies of the worked example's files that the ts-hexagonal emitters
// reproduce. Generated files are compared byte for byte; skeleton files by
// their declarations (see declarationShape in emitters.test.ts), because the
// example's bodies are the builder's work.

/** Context-source-root-relative path → exact example text. */
export const GENERATED: Readonly<Record<string, string>> = {
  "domain/shared/result.ts": `export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };
`,
  "domain/index.ts": `export type { Result } from "./shared/result.ts";

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
`,
  "application/index.ts": `// Contracts are exported as types. Commands are exported from their implementation file (type and value together).
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
`,
  "application/notes/create-note/create-note.command.ts": `import { z } from "zod";
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
`,
  "application/projects/create-project/create-project.command.ts": `import { z } from "zod";
import { ProjectName, type Result } from "@example/project-management/domain";
import type * as Contract from "./create-project.contract.ts";

// Wire contract: tRPC and MCP use this for their input types.
export const createProjectSchema = z.object({
  name: z.string(),
}) satisfies z.ZodType<Contract.CreateProjectInput>;

class CreateProjectCommandImpl implements Contract.CreateProjectCommand {
  declare readonly __brand: "CreateProjectCommand";
  private constructor(readonly name: ProjectName) {}

  static parse(raw: unknown): Result<CreateProjectCommand> {
    const input = createProjectSchema.safeParse(raw);
    if (!input.success) return { ok: false, error: "Invalid create project input" };
    const name = ProjectName.parse(input.data.name);
    return name.ok ? { ok: true, value: new CreateProjectCommandImpl(name.value) } : name;
  }
}

export type CreateProjectCommand = Contract.CreateProjectCommand;
export const CreateProjectCommand: Contract.CreateProjectCommandFactory = CreateProjectCommandImpl;
`,
  "adapters/out/in-memory/index.ts": `export { InMemoryDatabase } from "./in-memory-database.ts";
export { InMemoryCreateNoteStore } from "./notes/create-note.store.ts";
export { InMemoryListNotesStore } from "./notes/list-notes.store.ts";
export { InMemoryCreateProjectStore } from "./projects/create-project.store.ts";
export { InMemoryExportProjectsStore } from "./projects/export-projects.store.ts";
export { InMemoryListProjectsStore } from "./projects/list-projects.store.ts";
`,
  "adapters/out/console/index.ts": `export { ConsoleProjectExporter } from "./projects/export-projects.exporter.ts";
`,
};

/** Context-source-root-relative path → the example's implemented file. */
export const SKELETONS: Readonly<Record<string, string>> = {
  "application/notes/create-note/create-note.handler.ts": `import { Note, NoteId, type Result } from "@example/project-management/domain";
import type { CreateNote, CreateNoteCommand, CreateNoteStore } from "./create-note.contract.ts";

export class CreateNoteHandler implements CreateNote {
  constructor(private readonly store: CreateNoteStore) {}

  async execute(command: CreateNoteCommand): Promise<Result<Note>> {
    if (!(await this.store.projectExists(command.projectId))) {
      return { ok: false, error: "Project not found" };
    }
    const note = new Note(NoteId.generate(), command.projectId, command.text);
    await this.store.save(note);
    return { ok: true, value: note };
  }
}
`,
  "application/notes/list-notes/list-notes.handler.ts": `import type { Note } from "@example/project-management/domain";
import type { ListNotes, ListNotesStore } from "./list-notes.contract.ts";

export class ListNotesHandler implements ListNotes {
  constructor(private readonly store: ListNotesStore) {}

  execute(): Promise<Note[]> {
    return this.store.findAll();
  }
}
`,
  "application/projects/create-project/create-project.handler.ts": `import { Project, ProjectId } from "@example/project-management/domain";
import type { CreateProject, CreateProjectCommand, CreateProjectStore } from "./create-project.contract.ts";

export class CreateProjectHandler implements CreateProject {
  constructor(private readonly store: CreateProjectStore) {}

  async execute(command: CreateProjectCommand): Promise<Project> {
    const project = new Project(ProjectId.generate(), command.name);
    await this.store.save(project);
    return project;
  }
}
`,
  "application/projects/export-projects/export-projects.handler.ts": `import type { ExportProjects, ExportProjectsStore, ProjectExporter } from "./export-projects.contract.ts";

export class ExportProjectsHandler implements ExportProjects {
  constructor(
    private readonly store: ExportProjectsStore,
    private readonly exporter: ProjectExporter,
  ) {}

  async execute(): Promise<void> {
    await this.exporter.export(await this.store.findAll());
  }
}
`,
  "application/projects/list-projects/list-projects.handler.ts": `import type { Project } from "@example/project-management/domain";
import type { ListProjects, ListProjectsStore } from "./list-projects.contract.ts";

export class ListProjectsHandler implements ListProjects {
  constructor(private readonly store: ListProjectsStore) {}

  execute(): Promise<Project[]> {
    return this.store.findAll();
  }
}
`,
  "adapters/out/in-memory/in-memory-database.ts": `import type { Note, Project } from "@example/project-management/domain";

// Shared data behind every in-memory store (later: a database connection).
export class InMemoryDatabase {
  readonly notes: Note[] = [];
  readonly projects: Project[] = [];
}
`,
  "adapters/out/in-memory/notes/create-note.store.ts": `import type { CreateNoteStore } from "@example/project-management/application";
import type { Note, ProjectId } from "@example/project-management/domain";
import type { InMemoryDatabase } from "../in-memory-database.ts";

export class InMemoryCreateNoteStore implements CreateNoteStore {
  constructor(private readonly db: InMemoryDatabase) {}

  async projectExists(id: ProjectId): Promise<boolean> {
    return this.db.projects.some((project) => project.id.equals(id));
  }

  async save(note: Note): Promise<void> {
    this.db.notes.push(note);
  }
}
`,
  "adapters/out/in-memory/notes/list-notes.store.ts": `import type { ListNotesStore } from "@example/project-management/application";
import type { Note } from "@example/project-management/domain";
import type { InMemoryDatabase } from "../in-memory-database.ts";

export class InMemoryListNotesStore implements ListNotesStore {
  constructor(private readonly db: InMemoryDatabase) {}

  async findAll(): Promise<Note[]> {
    return [...this.db.notes];
  }
}
`,
  "adapters/out/in-memory/projects/create-project.store.ts": `import type { CreateProjectStore } from "@example/project-management/application";
import type { Project } from "@example/project-management/domain";
import type { InMemoryDatabase } from "../in-memory-database.ts";

export class InMemoryCreateProjectStore implements CreateProjectStore {
  constructor(private readonly db: InMemoryDatabase) {}

  async save(project: Project): Promise<void> {
    this.db.projects.push(project);
  }
}
`,
  "adapters/out/in-memory/projects/export-projects.store.ts": `import type { ExportProjectsStore } from "@example/project-management/application";
import type { Project } from "@example/project-management/domain";
import type { InMemoryDatabase } from "../in-memory-database.ts";

export class InMemoryExportProjectsStore implements ExportProjectsStore {
  constructor(private readonly db: InMemoryDatabase) {}

  async findAll(): Promise<Project[]> {
    return [...this.db.projects];
  }
}
`,
  "adapters/out/in-memory/projects/list-projects.store.ts": `import type { ListProjectsStore } from "@example/project-management/application";
import type { Project } from "@example/project-management/domain";
import type { InMemoryDatabase } from "../in-memory-database.ts";

export class InMemoryListProjectsStore implements ListProjectsStore {
  constructor(private readonly db: InMemoryDatabase) {}

  async findAll(): Promise<Project[]> {
    return [...this.db.projects];
  }
}
`,
  "adapters/out/console/projects/export-projects.exporter.ts": `import type { ProjectExporter } from "@example/project-management/application";
import type { Project } from "@example/project-management/domain";

// Local stand-in for the S3 CSV exporter.
export class ConsoleProjectExporter implements ProjectExporter {
  async export(projects: Project[]): Promise<void> {
    console.table(projects.map((project) => project.toJSON()));
  }
}
`,
};
