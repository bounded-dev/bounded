// Inline copies of the worked example's project-management context: its
// feature and domain contracts, its Drizzle schema and its first migration.
// The pack's tests compare against these, never against a path outside the
// harness, so they run anywhere.
import type { ContractSource, EmitPhase, ProjectFacts, WorkspaceFacts } from "../../ts/pack.ts";

export const SCOPE = "@example";
export const CONTEXT = "project-management";
export const CONTEXT_DIR = `contexts/${CONTEXT}`;
export const SOURCE_ROOT = `${CONTEXT_DIR}/src`;
export const PACKAGE = `${SCOPE}/${CONTEXT}`;

const lines = (...text: string[]): string => text.join("\n") + "\n";

/** Source-root-relative path → contract text. */
export const APPLICATION_CONTRACTS: Readonly<Record<string, string>> = {
  "application/notes/create-note/create-note.contract.ts": lines(
    'import type { Note, NoteText, ProjectId, Result } from "@example/project-management/domain";',
    "",
    "// Wire input: what callers send.",
    "export interface CreateNoteInput {",
    "  readonly projectId: string;",
    "  readonly text: string;",
    "}",
    "",
    "// Command: the input once validated into value objects.",
    "export interface CreateNoteCommand {",
    '  readonly __brand: "CreateNoteCommand";',
    "  readonly projectId: ProjectId;",
    "  readonly text: NoteText;",
    "}",
    "",
    "export interface CreateNoteCommandFactory {",
    "  parse(raw: unknown): Result<CreateNoteCommand>;",
    "}",
    "",
    "// In port: what this feature offers.",
    "/**",
    " * Create a note",
    " * @exposedVia trpc",
    " */",
    "export interface CreateNote {",
    "  execute(command: CreateNoteCommand): Promise<Result<Note>>;",
    "}",
    "",
    "// Out port: exactly what this feature needs.",
    "export interface CreateNoteStore {",
    "  projectExists(id: ProjectId): Promise<boolean>;",
    "  save(note: Note): Promise<void>;",
    "}",
  ),
  "application/notes/list-notes/list-notes.contract.ts": lines(
    'import type { Note } from "@example/project-management/domain";',
    "",
    "// In port: what this feature offers.",
    "export interface ListNotes {",
    "  execute(): Promise<Note[]>;",
    "}",
    "",
    "// Out port: exactly what this feature needs.",
    "export interface ListNotesStore {",
    "  findAll(): Promise<Note[]>;",
    "}",
  ),
  "application/projects/create-project/create-project.contract.ts": lines(
    'import type { Project, ProjectName, Result } from "@example/project-management/domain";',
    "",
    "// Wire input: what callers send.",
    "export interface CreateProjectInput {",
    "  readonly name: string;",
    "}",
    "",
    "// Command: the input once validated into value objects.",
    "export interface CreateProjectCommand {",
    '  readonly __brand: "CreateProjectCommand";',
    "  readonly name: ProjectName;",
    "}",
    "",
    "export interface CreateProjectCommandFactory {",
    "  parse(raw: unknown): Result<CreateProjectCommand>;",
    "}",
    "",
    "// In port: what this feature offers.",
    "export interface CreateProject {",
    "  execute(command: CreateProjectCommand): Promise<Project>;",
    "}",
    "",
    "// Out port: exactly what this feature needs.",
    "export interface CreateProjectStore {",
    "  save(project: Project): Promise<void>;",
    "}",
  ),
  "application/projects/export-projects/export-projects.contract.ts": lines(
    'import type { Project } from "@example/project-management/domain";',
    "",
    "// In port: what this feature offers.",
    "export interface ExportProjects {",
    "  execute(): Promise<void>;",
    "}",
    "",
    "// Out ports: exactly what this feature needs.",
    "export interface ExportProjectsStore {",
    "  findAll(): Promise<Project[]>;",
    "}",
    "",
    "/** @implementedBy console */",
    "export interface ProjectExporter {",
    "  export(projects: Project[]): Promise<void>;",
    "}",
  ),
  "application/projects/list-projects/list-projects.contract.ts": lines(
    'import type { Project } from "@example/project-management/domain";',
    "",
    "// In port: what this feature offers.",
    "export interface ListProjects {",
    "  execute(): Promise<Project[]>;",
    "}",
    "",
    "// Out port: exactly what this feature needs.",
    "export interface ListProjectsStore {",
    "  findAll(): Promise<Project[]>;",
    "}",
  ),
};

const valueObject = (name: string, identifier: boolean): string => lines(
  'import type { Result } from "../shared/result.ts";',
  "",
  `export interface ${name} {`,
  `  readonly __brand: "${name}";`,
  "  readonly value: string;",
  `  equals(other: ${name}): boolean;`,
  "  toJSON(): string;",
  "}",
  "",
  `export interface ${name}Factory {`,
  ...(identifier ? [`  generate(): ${name};`] : []),
  `  parse(raw: unknown): Result<${name}>;`,
  "}",
);

export const DOMAIN_CONTRACTS: Readonly<Record<string, string>> = {
  "domain/notes/note-id.contract.ts": valueObject("NoteId", true),
  "domain/notes/note-text.contract.ts": valueObject("NoteText", false),
  "domain/notes/note.contract.ts": lines(
    'import type { ProjectId } from "../projects/project-id.contract.ts";',
    'import type { NoteId } from "./note-id.contract.ts";',
    'import type { NoteText } from "./note-text.contract.ts";',
    "",
    "export interface Note {",
    '  readonly __brand: "Note";',
    "  readonly id: NoteId;",
    "  readonly projectId: ProjectId;",
    "  readonly text: NoteText;",
    "  equals(other: Note): boolean;",
    "  toJSON(): { readonly id: string; readonly projectId: string; readonly text: string };",
    "}",
    "",
    "export interface NoteFactory {",
    "  new (id: NoteId, projectId: ProjectId, text: NoteText): Note;",
    "}",
  ),
  "domain/projects/project-id.contract.ts": valueObject("ProjectId", true),
  "domain/projects/project-name.contract.ts": valueObject("ProjectName", false),
  "domain/projects/project.contract.ts": lines(
    'import type { ProjectId } from "./project-id.contract.ts";',
    'import type { ProjectName } from "./project-name.contract.ts";',
    "",
    "export interface Project {",
    '  readonly __brand: "Project";',
    "  readonly id: ProjectId;",
    "  readonly name: ProjectName;",
    "  equals(other: Project): boolean;",
    "  toJSON(): { readonly id: string; readonly name: string };",
    "}",
    "",
    "export interface ProjectFactory {",
    "  new (id: ProjectId, name: ProjectName): Project;",
    "}",
  ),
};

export const RESULT_SOURCE = lines("export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };");

/** The example's `schema/` folder, file name → text. */
export const EXAMPLE_SCHEMA: Readonly<Record<string, string>> = {
  "project-management.schema.ts": lines(
    'import { pgSchema } from "drizzle-orm/pg-core";',
    "",
    "// Every table in this context lives in its own Postgres schema.",
    'export const projectManagement = pgSchema("project_management");',
  ),
  "projects.ts": lines(
    'import { text, uuid } from "drizzle-orm/pg-core";',
    'import { projectManagement } from "./project-management.schema.ts";',
    "",
    'export const projects = projectManagement.table("projects", {',
    '  id: uuid("id").primaryKey(),',
    '  name: text("name").notNull(),',
    "});",
  ),
  "notes.ts": lines(
    'import { text, uuid } from "drizzle-orm/pg-core";',
    'import { projectManagement } from "./project-management.schema.ts";',
    'import { projects } from "./projects.ts";',
    "",
    'export const notes = projectManagement.table("notes", {',
    '  id: uuid("id").primaryKey(),',
    '  projectId: uuid("project_id")',
    "    .notNull()",
    "    .references(() => projects.id),",
    '  text: text("text").notNull(),',
    "});",
  ),
};

/** The example's `migrations/0000_mute_wong.sql`, byte for byte (no final newline). */
export const EXAMPLE_FIRST_MIGRATION = [
  'CREATE SCHEMA "project_management";',
  "--> statement-breakpoint",
  'CREATE TABLE "project_management"."notes" (',
  '\t"id" uuid PRIMARY KEY NOT NULL,',
  '\t"project_id" uuid NOT NULL,',
  '\t"text" text NOT NULL',
  ");",
  "--> statement-breakpoint",
  'CREATE TABLE "project_management"."projects" (',
  '\t"id" uuid PRIMARY KEY NOT NULL,',
  '\t"name" text NOT NULL',
  ");",
  "--> statement-breakpoint",
  'ALTER TABLE "project_management"."notes" ADD CONSTRAINT "notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") ' +
    'REFERENCES "project_management"."projects"("id") ON DELETE no action ON UPDATE no action;',
].join("\n");

/** Contract sources of a context, sorted by path, as the gates hand them over. */
export function contractSources(sourceRoot = SOURCE_ROOT, contracts: Readonly<Record<string, string>> = {
  ...APPLICATION_CONTRACTS, ...DOMAIN_CONTRACTS,
}): ContractSource[] {
  return Object.entries(contracts)
    .map(([path, source]) => ({ path: `${sourceRoot}/${path}`, source }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function contextWorkspace(name = CONTEXT, contracts?: Readonly<Record<string, string>>): WorkspaceFacts {
  const dir = `contexts/${name}`;
  return {
    dir, name, kind: "context", packageName: `${SCOPE}/${name}`, sourceRoot: `${dir}/src`,
    contracts: contractSources(`${dir}/src`, contracts),
  };
}

export function exampleFacts(phase: EmitPhase = "design", workspaces: readonly WorkspaceFacts[] = [contextWorkspace()]): ProjectFacts {
  return {
    scope: SCOPE, phase, packs: ["ts", "ts-hexagonal", "ts-drizzle-postgres"],
    workspaces: [...workspaces].sort((a, b) => (a.dir < b.dir ? -1 : 1)),
    adapterTechnologies: [], workspaceTemplates: [],
  };
}
