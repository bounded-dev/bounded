import { describe, expect, test } from "vitest";
import { readDomainConcept } from "./domain-index.ts";
import { ContractShapeError, type FeatureParseOptions, parseFeatureContract } from "./feature-contract.ts";
import { APPLICATION_CONTRACTS, CREATE_NOTE, DOMAIN_CONTRACTS, ROOT, SCOPE, TECHNOLOGIES } from "./testdata/example-contracts.ts";

const CONCEPTS = new Map(Object.entries(DOMAIN_CONTRACTS).map(([path, source]) => {
  const concept = readDomainConcept(`${ROOT}/${path}`, source);
  return [concept.name, concept.kind] as const;
}));
const OPTIONS: FeatureParseOptions = { scope: SCOPE, concepts: CONCEPTS, adapterTechnologies: TECHNOLOGIES };
const CREATE_NOTE_PATH = `${ROOT}/application/notes/create-note/create-note.contract.ts`;

const parse = (source: string, path = CREATE_NOTE_PATH, options = OPTIONS) => parseFeatureContract(path, source, options);
const refuses = (source: string, message: RegExp, path = CREATE_NOTE_PATH, options = OPTIONS): void => {
  let error: unknown;
  try {
    parse(source, path, options);
  } catch (caught) {
    error = caught;
  }
  expect(error, `expected a refusal matching ${message}`).toBeInstanceOf(ContractShapeError);
  expect((error as Error).message).toMatch(message);
  expect((error as Error).message).toContain(path);
};

describe("parseFeatureContract on the worked example", () => {
  test("create-note: input, command fields, in port, the store and the tag", () => {
    const model = parse(CREATE_NOTE);
    expect(model).toEqual({
      context: "project-management",
      area: "notes",
      feature: "create-note",
      kind: "command",
      contractPath: CREATE_NOTE_PATH,
      domainImport: "@example/project-management/domain",
      domainTypes: ["Note", "NoteText", "ProjectId"],
      input: {
        inputName: "CreateNoteInput",
        commandName: "CreateNoteCommand",
        commandFactoryName: "CreateNoteCommandFactory",
        schemaName: "createNoteSchema",
        fields: [
          { name: "projectId", wireType: "string", concept: "ProjectId" },
          { name: "text", wireType: "string", concept: "NoteText" },
        ],
      },
      inPort: {
        name: "CreateNote",
        parameter: { name: "command", type: { kind: "local", text: "CreateNoteCommand", name: "CreateNoteCommand" } },
        returns: { text: "Promise<Result<Note>>", result: true, shape: "value", concept: "Note" },
      },
      outPorts: [{
        name: "CreateNoteStore",
        role: "store",
        isStore: true,
        implementedBy: [],
        methods: [
          {
            name: "projectExists",
            parameters: [{ name: "id", type: { kind: "concept", text: "ProjectId", name: "ProjectId" } }],
            returns: { kind: "promise", text: "Promise<boolean>", value: { kind: "primitive", text: "boolean", name: "boolean" } },
          },
          {
            name: "save",
            parameters: [{ name: "note", type: { kind: "concept", text: "Note", name: "Note" } }],
            returns: { kind: "promise", text: "Promise<void>", value: { kind: "void", text: "void" } },
          },
        ],
      }],
      exposedVia: ["trpc"],
      doc: "Create a note",
    });
  });

  test("every example feature parses, with its kind, return shape, tags and out-port order", () => {
    const models = Object.entries(APPLICATION_CONTRACTS).map(([path, source]) => parse(source, `${ROOT}/${path}`));
    expect(models.map((m) => [m.feature, m.kind, m.inPort.returns.shape, m.inPort.returns.result, m.exposedVia.join(" ")])).toEqual([
      ["create-note", "command", "value", true, "trpc"],
      ["list-notes", "query", "array", false, "trpc"],
      ["create-project", "command", "value", false, "trpc mcp"],
      ["export-projects", "command", "void", false, "lambda"],
      ["list-projects", "query", "array", false, "trpc mcp"],
    ]);
    const exportProjects = models[3]!;
    expect(exportProjects.input).toBeUndefined();
    expect(exportProjects.inPort.parameter).toBeUndefined();
    expect(exportProjects.outPorts.map((p) => [p.name, p.role, p.isStore, p.implementedBy])).toEqual([
      ["ExportProjectsStore", "store", true, []],
      ["ProjectExporter", "exporter", false, ["console"]],
    ]);
    expect(exportProjects.outPorts[1]!.doc).toBe("Hand the projects to an export destination");
    expect(models[2]!.doc).toBe("Create a project");
  });

  test("the parse is pure: the same text gives the same model", () => {
    expect(parse(CREATE_NOTE)).toEqual(parse(CREATE_NOTE));
  });

  test("without composition facts it checks the grammar only", () => {
    const model = parse(CREATE_NOTE.replace("@exposedVia trpc", "@exposedVia graphql"), CREATE_NOTE_PATH, { scope: SCOPE });
    expect(model.exposedVia).toEqual(["graphql"]);
  });

  test("a multi-line summary joins with single spaces and stops at the first tag", () => {
    const source = CREATE_NOTE.replace(" * Create a note\n", " * Create a note\n *   in a project\n *\n");
    expect(parse(source).doc).toBe("Create a note in a project");
  });
});

describe("parseFeatureContract refuses what TN-26-012 does not allow", () => {
  const replace = (from: string, to: string): string => {
    expect(CREATE_NOTE).toContain(from);
    return CREATE_NOTE.replace(from, to);
  };

  test.each([
    ["a path outside the feature layout", `${ROOT}/application/notes/create-note.contract.ts`, /feature contract lives at/],
    ["a file not named after its folder", `${ROOT}/application/notes/create-note/note.contract.ts`, /must be named 'create-note.contract.ts'/],
    ["a singular area", `${ROOT}/application/note/create-note/create-note.contract.ts`, /plural business noun/],
    ["a one-word feature", `${ROOT}/application/notes/create/create.contract.ts`, /at least two words/],
    ["a noun-first feature", `${ROOT}/application/notes/note-create/note-create.contract.ts`, /verb first/],
    ["a camelCase context", `contexts/projectManagement/src/application/notes/create-note/create-note.contract.ts`, /not kebab-case/],
  ])("%s", (_, path, message) => {
    refuses(CREATE_NOTE, message, path);
  });

  test.each([
    ["a second import", ['import type { Note', 'import type { Z } from "./z.ts";\nimport type { Note'], /exactly one import|only import allowed/],
    ["a value import", ['import type { Note, NoteText', 'import { Note, NoteText'], /must be exactly import type/],
    ["an inline type import", ['import type { Note, NoteText', 'import { type Note, type NoteText'], /must be exactly import type/],
    ["another context's domain", ['"@example/project-management/domain"', '"@example/billing/domain"'], /only import allowed/],
    ["an implementation import", ['"@example/project-management/domain"', '"../../../domain/notes/note.ts"'], /only import allowed/],
    ["unsorted names", ["Note, NoteText, ProjectId, Result", "NoteText, Note, ProjectId, Result"], /sort the imported names/],
    ["an unused name", ["Note, NoteText, ProjectId, Result", "Note, NoteId, NoteText, ProjectId, Result"], /'NoteId' is imported but not used/],
    ["an unknown concept", ["Note, NoteText, ProjectId, Result", "Note, NoteText, ProjectId, Result, Tag"], /'Tag' is not a domain concept/],
    ["an aliased import", ["ProjectId, Result", "ProjectId as Pid, Result"], /no aliases/],
    ["an undeclared type", ["save(note: Note)", "save(note: Draft)"], /'Draft' is neither imported/],
    ["a type alias", ["// Out port: exactly", "export type Extra = string;\n// Out port: exactly"], /only one type import and exported interfaces/],
    ["an unexported interface", ["export interface CreateNoteStore", "interface CreateNoteStore"], /must be declared 'export interface'/],
    ["an interface that extends", ["export interface CreateNoteStore {", "export interface CreateNoteStore extends CreateNote {"], /may not extend/],
    ["a generic interface", ["export interface CreateNoteStore {", "export interface CreateNoteStore<T> {"], /may not be generic/],
    ["Input without Command", ["export interface CreateNoteCommandFactory {\n  parse(raw: unknown): Result<CreateNoteCommand>;\n}\n", ""], /Input, Command and CommandFactory are all present or all absent|first and in that order/],
    ["the in port before the command", ["export interface CreateNoteInput {", "export interface CreateNote {\n  execute(command: CreateNoteCommand): Promise<Result<Note>>;\n}\nexport interface CreateNoteInput {"], /first and in that order|declared twice/],
    ["an optional input field", ["readonly text: string;\n}", "readonly text?: string;\n}"], /readonly and required/],
    ["a mutable input field", ["  readonly text: string;\n}", "  text: string;\n}"], /readonly and required/],
    ["an array input field", ["readonly text: string;\n}", "readonly text: string[];\n}"], /string, number or boolean/],
    ["a reserved field name", ["readonly text: string;\n}\n\n// Command", "readonly input: string;\n}\n\n// Command"], /field names are camelCase identifiers/],
    ["a command field out of order", ["readonly projectId: ProjectId;\n  readonly text: NoteText;", "readonly text: NoteText;\n  readonly projectId: ProjectId;"], /same order/],
    ["a command without its brand", ['  readonly __brand: "CreateNoteCommand";\n', ""], /starts with 'readonly __brand/],
    ["a wrong brand", ['__brand: "CreateNoteCommand"', '__brand: "CreateNote"'], /starts with 'readonly __brand/],
    ["a factory with a different parse", ["parse(raw: unknown): Result<CreateNoteCommand>;", "parse(raw: string): Result<CreateNoteCommand>;"], /is exactly/],
    ["a factory with a second member", ["parse(raw: unknown): Result<CreateNoteCommand>;", "parse(raw: unknown): Result<CreateNoteCommand>;\n  empty(): CreateNoteCommand;"], /is exactly/],
    ["an in port with two members", ["execute(command: CreateNoteCommand): Promise<Result<Note>>;", "execute(command: CreateNoteCommand): Promise<Result<Note>>;\n  cancel(): Promise<void>;"], /exactly one member, execute/],
    ["an in port method not named execute", ["execute(command: CreateNoteCommand)", "run(command: CreateNoteCommand)"], /exactly one member, execute/],
    ["execute taking the input", ["execute(command: CreateNoteCommand)", "execute(command: CreateNoteInput)"], /takes exactly \(command: CreateNoteCommand\)/],
    ["execute returning a bare value", ["execute(command: CreateNoteCommand): Promise<Result<Note>>", "execute(command: CreateNoteCommand): Result<Note>"], /returns Promise<R> or Promise<Result<R>>/],
    ["execute returning a primitive", ["execute(command: CreateNoteCommand): Promise<Result<Note>>", "execute(command: CreateNoteCommand): Promise<string>"], /returns Promise<R> or Promise<Result<R>>/],
    ["an optional execute", ["execute(command", "execute?(command"], /plain methods/],
    ["a store not named after the feature", ["export interface CreateNoteStore", "export interface NoteStore"], /named exactly CreateNoteStore/],
    ["a store with @implementedBy", ["// Out port: exactly what this feature needs.\n", "/**\n * @implementedBy console\n */\n"], /takes no @implementedBy/],
    ["an out port method that is not async", ["save(note: Note): Promise<void>;", "save(note: Note): void;"], /must return a Promise/],
    ["an out-port overload", ["save(note: Note): Promise<void>;", "save(note: Note): Promise<void>;\n  save(notes: Note[]): Promise<void>;"], /overloads are not allowed/],
    ["an optional parameter", ["save(note: Note)", "save(note?: Note)"], /parameters are plain/],
    ["a rest parameter", ["save(note: Note)", "save(...notes: Note[])"], /parameters are plain/],
    ["an index type", ["save(note: Note)", "save(note: Note[\"id\"])"], /too clever/],
    ["a keyof type", ["save(note: Note)", "save(note: keyof Note)"], /too clever/],
    ["a syntax error", ["export interface CreateNoteStore {", "export interface CreateNoteStore {{"], /does not parse/],
  ])("%s", (_, [from, to], message) => {
    refuses(replace(from!, to!), message as RegExp);
  });

  test.each([
    ["a reserved word", "delete", /'delete' is a reserved word/],
    ["a strict-mode reserved word", "implements", /'implements' is a reserved word/],
    ["arguments", "arguments", /'arguments' cannot be bound in strict-mode code/],
    ["eval", "eval", /'eval' cannot be bound in strict-mode code/],
    ["constructor", "constructor", /'constructor' is a member every object already has/],
    ["__proto__", "__proto__", /'__proto__' is a member every object already has/],
    ["the brand", "__brand", /'__brand' is a member every object already has/],
    ["a snake_case name", "project_id", /camelCase identifiers/],
  ])("an Input field named as %s is refused", (_, field, message) => {
    const source = CREATE_NOTE.replace("readonly text: string;", `readonly ${field}: string;`)
      .replace("readonly text: NoteText;", `readonly ${field}: NoteText;`);
    refuses(source, message);
  });

  test("a field declared twice is refused, in Input or in Command", () => {
    refuses(CREATE_NOTE.replace("readonly text: string;\n}", "readonly text: string;\n  readonly text: string;\n}"),
      /CreateNoteInput declares the field 'text' twice/);
    refuses(CREATE_NOTE.replace("readonly text: NoteText;\n}", "readonly text: NoteText;\n  readonly text: NoteText;\n}"),
      /CreateNoteCommand declares the field 'text' twice/);
  });

  test.each(["constructor", "__proto__", "then", "toString", "hasOwnProperty", "prototype"])(
    "an out-port method named %s is refused", (method) => {
      refuses(CREATE_NOTE.replace("save(note: Note): Promise<void>;", `${method}(note: Note): Promise<void>;`),
        new RegExp(`CreateNoteStore\\.${method}: '${method}' is a member every object already has`));
    });

  test.each([["eval", /'eval' cannot be bound/], ["arguments", /'arguments' cannot be bound/], ["yield", /'yield' is a reserved word/]])(
    "an out-port parameter named %s is refused", (param, message) => {
      refuses(CREATE_NOTE.replace("save(note: Note)", `save(${param}: Note)`), message);
    });

  test("ordinary method and parameter names that merely look special are allowed", () => {
    const model = parse(CREATE_NOTE.replace("save(note: Note)", "delete(constructor: Note)"));
    expect(model.outPorts[0]!.methods[1]).toMatchObject({ name: "delete", parameters: [{ name: "constructor" }] });
  });

  test("command fields are value objects or identifiers, never primitives or entities", () => {
    const withoutText = CREATE_NOTE.replace("Note, NoteText, ProjectId, Result", "Note, ProjectId, Result");
    refuses(withoutText.replace("readonly text: NoteText;", "readonly text: string;"), /typed by a domain value object/);
    refuses(withoutText.replace("readonly text: NoteText;", "readonly text: Note;"), /not a value object or identifier/);
  });

  const EXPORTER = APPLICATION_CONTRACTS["application/projects/export-projects/export-projects.contract.ts"]!;
  const EXPORT_PATH = `${ROOT}/application/projects/export-projects/export-projects.contract.ts`;
  const exportRefuses = (from: string, to: string, message: RegExp): void => {
    expect(EXPORTER).toContain(from);
    refuses(EXPORTER.replace(from, to), message, EXPORT_PATH);
  };

  test("a non-store out port needs @implementedBy", () => {
    exportRefuses("/**\n * Hand the projects to an export destination\n * @implementedBy console\n */\n", "", /needs '@implementedBy <technology>'/);
  });

  test("a non-store port ending in Store is refused", () => {
    exportRefuses("export interface ProjectExporter", "export interface ProjectArchiveStore", /named exactly ExportProjectsStore/);
  });

  test("two ports with one role are refused", () => {
    exportRefuses("export interface ProjectExporter {\n  export(projects: Project[]): Promise<void>;\n}\n",
      "export interface ProjectExporter {\n  export(projects: Project[]): Promise<void>;\n}\n\n/**\n * @implementedBy console\n */\n" +
      "export interface CsvExporter {\n  export(projects: Project[]): Promise<void>;\n}\n", /share the role 'exporter'/);
  });

  test("a port whose role is already a file role is refused", () => {
    exportRefuses("export interface ProjectExporter", "export interface ProjectHandler", /already a file role/);
  });

  test("tags must name composed technologies of the right direction", () => {
    exportRefuses("@implementedBy console", "@implementedBy s3", /'s3', which no composed pack contributes/);
    exportRefuses("@implementedBy console", "@implementedBy in-memory", /not a non-storage out adapter/);
    exportRefuses("@implementedBy console", "@implementedBy trpc", /not a non-storage out adapter/);
    exportRefuses("@exposedVia lambda", "@exposedVia console", /not an in adapter/);
  });

  test("near-miss tags are refused, never ignored", () => {
    exportRefuses("@exposedVia lambda", "@exposedvia lambda", /not a valid tag line/);
    exportRefuses("@exposedVia lambda", "@exposedVia Lambda", /not a valid tag line/);
    exportRefuses("@exposedVia lambda", "@exposedVia", /not a valid tag line/);
    exportRefuses("@exposedVia lambda", "@exposedVia lambda lambda", /names 'lambda' twice/);
    exportRefuses("@exposedVia lambda", "@exposedVia lambda\n * @exposedVia trpc", /at most one @exposedVia/);
    exportRefuses("// In port: what this feature offers.\n", "// @exposedVia trpc\n", /appear only as one tag line/);
    exportRefuses("@exposedVia lambda", "Exposed with @exposedVia lambda", /appear only as one tag line/);
    exportRefuses("@implementedBy console", "@exposedVia trpc", /may not carry @exposedVia/);
  });

  test("a tag block must sit directly above its interface", () => {
    exportRefuses("/**\n * Export every project\n * @exposedVia lambda\n */\nexport interface ExportProjects",
      "/**\n * Export every project\n * @exposedVia lambda\n */\n// stray\nexport interface ExportProjects", /directly above it/);
  });

  test("an in port exposed via mcp needs a summary: it is the tool description", () => {
    const source = APPLICATION_CONTRACTS["application/projects/create-project/create-project.contract.ts"]!;
    refuses(source.replace(" * Create a project\n", ""), /needs a summary line/,
      `${ROOT}/application/projects/create-project/create-project.contract.ts`);
  });

  test("the in port may not carry @implementedBy", () => {
    exportRefuses("@exposedVia lambda", "@implementedBy console", /may carry @exposedVia only/);
  });

  test("a scope outside the grammar is refused", () => {
    refuses(CREATE_NOTE, /scope 'example'/, CREATE_NOTE_PATH, { ...OPTIONS, scope: "example" });
  });
});

describe("readDomainConcept", () => {
  test("reads the kind from the factory", () => {
    const kinds = Object.entries(DOMAIN_CONTRACTS).map(([path, source]) => {
      const c = readDomainConcept(`${ROOT}/${path}`, source);
      return [c.name, c.kind, c.area, c.stem];
    });
    expect(kinds).toEqual([
      ["NoteId", "identifier", "notes", "note-id"],
      ["NoteText", "value-object", "notes", "note-text"],
      ["Note", "entity", "notes", "note"],
      ["ProjectId", "identifier", "projects", "project-id"],
      ["ProjectName", "value-object", "projects", "project-name"],
      ["Project", "entity", "projects", "project"],
    ]);
  });

  test("refuses a contract whose names do not follow its file", () => {
    const source = DOMAIN_CONTRACTS["domain/notes/note-text.contract.ts"]!;
    expect(() => readDomainConcept(`${ROOT}/domain/notes/note-body.contract.ts`, source)).toThrow(/NoteBody/);
    expect(() => readDomainConcept(`${ROOT}/domain/note/note-text.contract.ts`, source)).toThrow(/plural business noun/);
    expect(() => readDomainConcept(`${ROOT}/domain/notes/deep/note-text.contract.ts`, source)).toThrow(/domain contract lives at/);
    expect(() => readDomainConcept(`${ROOT}/domain/notes/note-text.contract.ts`, source.replace("parse(raw: unknown): Result<NoteText>;", "")))
      .toThrow(/needs 'parse/);
  });
});
