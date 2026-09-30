// Inline copies of the worked example's design contracts (TN-26-012 §3, with
// the §4 tags added), shared by the parser, emitter and workspace tests. They
// are copies on purpose: the harness's suite must not read a path outside
// itself, and a test pinned to text it can see cannot drift silently.

import type { AdapterTechnology, ContractSource, ProjectFacts, WorkspaceFacts, WorkspaceTemplate } from "../../../ts/pack.ts";

export const SCOPE = "@example";
export const CONTEXT = "project-management";
export const ROOT = `contexts/${CONTEXT}/src`;

export const DOMAIN_CONTRACTS: Readonly<Record<string, string>> = {
  "domain/notes/note-id.contract.ts": `import type { Result } from "../shared/result.ts";

export interface NoteId {
  readonly __brand: "NoteId";
  readonly value: string;
  equals(other: NoteId): boolean;
  toJSON(): string;
}

export interface NoteIdFactory {
  generate(): NoteId;
  parse(raw: unknown): Result<NoteId>;
}
`,
  "domain/notes/note-text.contract.ts": `import type { Result } from "../shared/result.ts";

export interface NoteText {
  readonly __brand: "NoteText";
  readonly value: string;
  equals(other: NoteText): boolean;
  toJSON(): string;
}

export interface NoteTextFactory {
  parse(raw: unknown): Result<NoteText>;
}
`,
  "domain/notes/note.contract.ts": `import type { ProjectId } from "../projects/project-id.contract.ts";
import type { NoteId } from "./note-id.contract.ts";
import type { NoteText } from "./note-text.contract.ts";

export interface Note {
  readonly __brand: "Note";
  readonly id: NoteId;
  readonly projectId: ProjectId;
  readonly text: NoteText;
  equals(other: Note): boolean;
  toJSON(): { readonly id: string; readonly projectId: string; readonly text: string };
}

export interface NoteFactory {
  new (id: NoteId, projectId: ProjectId, text: NoteText): Note;
}
`,
  "domain/projects/project-id.contract.ts": `import type { Result } from "../shared/result.ts";

export interface ProjectId {
  readonly __brand: "ProjectId";
  readonly value: string;
  equals(other: ProjectId): boolean;
  toJSON(): string;
}

export interface ProjectIdFactory {
  generate(): ProjectId;
  parse(raw: unknown): Result<ProjectId>;
}
`,
  "domain/projects/project-name.contract.ts": `import type { Result } from "../shared/result.ts";

export interface ProjectName {
  readonly __brand: "ProjectName";
  readonly value: string;
  equals(other: ProjectName): boolean;
  toJSON(): string;
}

export interface ProjectNameFactory {
  parse(raw: unknown): Result<ProjectName>;
}
`,
  "domain/projects/project.contract.ts": `import type { ProjectId } from "./project-id.contract.ts";
import type { ProjectName } from "./project-name.contract.ts";

export interface Project {
  readonly __brand: "Project";
  readonly id: ProjectId;
  readonly name: ProjectName;
  equals(other: Project): boolean;
  toJSON(): { readonly id: string; readonly name: string };
}

export interface ProjectFactory {
  new (id: ProjectId, name: ProjectName): Project;
}
`,
};

export const CREATE_NOTE = `import type { Note, NoteText, ProjectId, Result } from "@example/project-management/domain";

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
 * Create a note
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
`;

export const APPLICATION_CONTRACTS: Readonly<Record<string, string>> = {
  "application/notes/create-note/create-note.contract.ts": CREATE_NOTE,
  "application/notes/list-notes/list-notes.contract.ts": `import type { Note } from "@example/project-management/domain";

// In port: what this feature offers.
/**
 * List all notes
 * @exposedVia trpc
 */
export interface ListNotes {
  execute(): Promise<Note[]>;
}

// Out port: exactly what this feature needs.
export interface ListNotesStore {
  findAll(): Promise<Note[]>;
}
`,
  "application/projects/create-project/create-project.contract.ts": `import type { Project, ProjectName, Result } from "@example/project-management/domain";

// Wire input: what callers send.
export interface CreateProjectInput {
  readonly name: string;
}

// Command: the input once validated into value objects.
export interface CreateProjectCommand {
  readonly __brand: "CreateProjectCommand";
  readonly name: ProjectName;
}

export interface CreateProjectCommandFactory {
  parse(raw: unknown): Result<CreateProjectCommand>;
}

// In port: what this feature offers.
/**
 * Create a project
 * @exposedVia trpc mcp
 */
export interface CreateProject {
  execute(command: CreateProjectCommand): Promise<Project>;
}

// Out port: exactly what this feature needs.
export interface CreateProjectStore {
  save(project: Project): Promise<void>;
}
`,
  "application/projects/export-projects/export-projects.contract.ts": `import type { Project } from "@example/project-management/domain";

// In port: what this feature offers.
/**
 * Export every project
 * @exposedVia lambda
 */
export interface ExportProjects {
  execute(): Promise<void>;
}

// Out ports: exactly what this feature needs.
export interface ExportProjectsStore {
  findAll(): Promise<Project[]>;
}

/**
 * Hand the projects to an export destination
 * @implementedBy console
 */
export interface ProjectExporter {
  export(projects: Project[]): Promise<void>;
}
`,
  "application/projects/list-projects/list-projects.contract.ts": `import type { Project } from "@example/project-management/domain";

// In port: what this feature offers.
/**
 * List all projects
 * @exposedVia trpc mcp
 */
export interface ListProjects {
  execute(): Promise<Project[]>;
}

// Out port: exactly what this feature needs.
export interface ListProjectsStore {
  findAll(): Promise<Project[]>;
}
`,
};

const NO_PINS = { dependencies: {}, devDependencies: {} };

/** The technologies the example composes, as their packs contribute them. */
export const TECHNOLOGIES: readonly AdapterTechnology[] = [
  { pack: "ts-hexagonal", id: "console", direction: "out", storage: false, pins: NO_PINS, description: "console" },
  { pack: "ts-drizzle-postgres", id: "drizzle", direction: "out", storage: true, pins: NO_PINS, description: "drizzle" },
  { pack: "ts-hexagonal", id: "in-memory", direction: "out", storage: true, pins: NO_PINS, description: "in memory" },
  { pack: "ts-lambda", id: "lambda", direction: "in", featureRole: "lambda", storage: false, pins: NO_PINS, description: "lambda" },
  { pack: "ts-mcp", id: "mcp", direction: "in", featureRole: "tool", storage: false, pins: NO_PINS, description: "mcp" },
  { pack: "ts-trpc", id: "trpc", direction: "in", featureRole: "procedure", storage: false, pins: NO_PINS, description: "trpc" },
];

/** The context template exactly as this pack's contrib.json contributes it. */
export const CONTEXT_TEMPLATE: WorkspaceTemplate = {
  pack: "ts-hexagonal",
  kind: "context",
  root: "contexts",
  manifest: "templates/context/package.json",
  files: [],
  description: "One bounded context: a package with domain, application and adapters under src/, exported per layer and per adapter technology.",
};

export function contracts(extra: Readonly<Record<string, string>> = {}): ContractSource[] {
  return Object.entries({ ...DOMAIN_CONTRACTS, ...APPLICATION_CONTRACTS, ...extra })
    .map(([path, source]) => ({ path: `${ROOT}/${path}`, source }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function contextWorkspace(sources: readonly ContractSource[] = contracts()): WorkspaceFacts {
  return {
    dir: `contexts/${CONTEXT}`,
    name: CONTEXT,
    kind: "context",
    packageName: `${SCOPE}/${CONTEXT}`,
    sourceRoot: ROOT,
    contracts: sources,
  };
}

export function exampleFacts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    scope: SCOPE,
    phase: "red",
    packs: ["ts", "ts-hexagonal"],
    workspaces: [contextWorkspace()],
    adapterTechnologies: TECHNOLOGIES,
    workspaceTemplates: [CONTEXT_TEMPLATE],
    ...overrides,
  };
}
