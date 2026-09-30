import { describe, expect, test } from "vitest";
import {
  acceptsExamplesOf,
  DomainConceptError,
  implementationPathOf,
  implementationSpecifierOf,
  isDomainConceptPath,
  lawsPathOf,
  parseDomainConcept,
  valueTypeOf,
} from "./domain-concept.ts";
import { EXAMPLE_CONCEPTS, exampleConcept } from "./testdata/example-domain.ts";

// The domain-concept parser (ADR 2026-059, TN-26-012 §3): the worked
// example's six contracts parse to the model every emitter codes against, and
// every shape outside the grammar is refused with the contract path and a fix.

const PATH = "contexts/pm/src/domain/projects/project-name.contract.ts";

function vo(instance: string, factory = "parse(raw: unknown): Result<ProjectName>;", imports = 'import type { Result } from "../shared/result.ts";'): string {
  return `${imports}\n\nexport interface ProjectName {\n  ${instance}\n}\n\nexport interface ProjectNameFactory {\n  ${factory}\n}\n`;
}

const VO_MEMBERS = 'readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;';

function refusal(path: string, source: string): string {
  try {
    parseDomainConcept(path, source);
  } catch (e) {
    expect(e).toBeInstanceOf(DomainConceptError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("paths", () => {
  test("recognises the TN-26-012 layout only", () => {
    expect(isDomainConceptPath("contexts/project-management/src/domain/notes/note-id.contract.ts")).toBe(true);
    expect(isDomainConceptPath("contexts/pm/src/domain/notes/note.contract.ts")).toBe(true);
    expect(isDomainConceptPath("contexts/pm/src/application/notes/create-note/create-note.contract.ts")).toBe(false);
    expect(isDomainConceptPath("contexts/pm/src/domain/note.contract.ts")).toBe(false);
    expect(isDomainConceptPath("contexts/pm/src/domain/notes/sub/note.contract.ts")).toBe(false);
    expect(isDomainConceptPath("contexts/pm/src/domain/Notes/note.contract.ts")).toBe(false);
    expect(isDomainConceptPath("contexts/pm/src/domain/notes/noteId.contract.ts")).toBe(false);
    expect(isDomainConceptPath("apps/web/src/domain/notes/note.contract.ts")).toBe(false);
    expect(isDomainConceptPath("/contexts/pm/src/domain/notes/note.contract.ts")).toBe(false);
  });

  test("derives the implementation, laws and specifier paths", () => {
    expect(implementationPathOf("contexts/pm/src/domain/notes/note-id.contract.ts")).toBe("contexts/pm/src/domain/notes/note-id.ts");
    expect(lawsPathOf("contexts/pm/src/domain/notes/note-id.contract.ts")).toBe("contexts/pm/src/domain/notes/note-id.laws.test.ts");
    expect(implementationSpecifierOf("../projects/project-id.contract.ts")).toBe("../projects/project-id.ts");
  });
});

describe("the worked example parses", () => {
  test.each(EXAMPLE_CONCEPTS.map((c) => [c.contractPath, c] as const))("%s", (_path, concept) => {
    const model = parseDomainConcept(concept.contractPath, concept.contract);
    expect(model.contractPath).toBe(concept.contractPath);
    expect(model.implementationPath).toBe(concept.contractPath.replace(".contract.ts", ".ts"));
    expect(model.context).toBe("project-management");
  });

  test("an identifier", () => {
    const model = parseDomainConcept(exampleConcept("note-id").contractPath, exampleConcept("note-id").contract);
    expect(model).toMatchObject({ kind: "identifier", name: "NoteId", stem: "note-id", area: "notes" });
    expect(model.fields).toEqual([{ name: "value", type: { kind: "primitive", text: "string", name: "string" }, readonly: true }]);
    expect(model.factoryMembers.map((m) => (m.kind === "method" ? m.name : "new"))).toEqual(["generate", "parse"]);
    const parse = model.factoryMembers[1]!;
    expect(parse).toMatchObject({
      kind: "method",
      parameters: [{ name: "raw", type: { kind: "other", text: "unknown" } }],
      returns: { kind: "result", text: "Result<NoteId>", value: { kind: "concept", name: "NoteId" } },
    });
    expect(model.instanceMethods.map((m) => m.name)).toEqual(["equals", "toJSON"]);
    expect(model.imports).toEqual([{ specifier: "../shared/result.ts", names: ["Result"] }]);
    expect(valueTypeOf(model)).toBe("string");
    expect(model.doc).toBeUndefined();
  });

  test("a value object", () => {
    const concept = exampleConcept("project-name");
    expect(parseDomainConcept(concept.contractPath, concept.contract)).toMatchObject({ kind: "value-object", name: "ProjectName" });
  });

  test("an entity", () => {
    const concept = exampleConcept("note");
    const model = parseDomainConcept(concept.contractPath, concept.contract);
    expect(model.kind).toBe("entity");
    expect(model.fields.map((f) => [f.name, f.type.kind, f.type.text])).toEqual([
      ["id", "concept", "NoteId"],
      ["projectId", "concept", "ProjectId"],
      ["text", "concept", "NoteText"],
    ]);
    expect(model.factoryMembers).toEqual([
      {
        kind: "construct",
        parameters: model.fields.map((f) => ({ name: f.name, type: f.type })),
      },
    ]);
    const toJSON = model.instanceMethods.find((m) => m.name === "toJSON")!;
    expect(toJSON.returns).toMatchObject({ kind: "object", text: "{ readonly id: string; readonly projectId: string; readonly text: string }" });
    expect(model.imports.map((i) => i.specifier)).toEqual([
      "../projects/project-id.contract.ts",
      "./note-id.contract.ts",
      "./note-text.contract.ts",
    ]);
  });

  test("a doc summary is read from the instance interface", () => {
    const model = parseDomainConcept(PATH, vo(VO_MEMBERS).replace("export interface ProjectName {", '/**\n * A project\'s name:\n * not empty.\n * @accepts "x"\n */\nexport interface ProjectName {'));
    expect(model.doc).toBe("A project's name: not empty.");
  });

  test("object types are printed canonically however they were wrapped", () => {
    const concept = exampleConcept("project");
    const wrapped = concept.contract.replace(
      "toJSON(): { readonly id: string; readonly name: string };",
      "toJSON(): {\n    readonly id: string;\n    readonly name: string;\n  };",
    );
    const model = parseDomainConcept(concept.contractPath, wrapped);
    expect(model.instanceMethods.find((m) => m.name === "toJSON")!.returns.text).toBe("{ readonly id: string; readonly name: string }");
  });

  test("parsing is deterministic", () => {
    const c = exampleConcept("note");
    expect(JSON.stringify(parseDomainConcept(c.contractPath, c.contract))).toBe(JSON.stringify(parseDomainConcept(c.contractPath, c.contract)));
  });
});

describe("@accepts examples", () => {
  const doc = (tags: string): string => vo(VO_MEMBERS).replace("export interface ProjectName {", `/**\n * A name.\n${tags}\n */\nexport interface ProjectName {`);

  test("reads each tag that opens its own line", () => {
    expect(acceptsExamplesOf(PATH, doc(' * @accepts "Website relaunch"\n * @accepts "Office move"'), "ProjectName")).toEqual([
      '"Website relaunch"',
      '"Office move"',
    ]);
    expect(acceptsExamplesOf(PATH, vo(VO_MEMBERS), "ProjectName")).toEqual([]);
  });

  test("a mid-sentence mention is prose", () => {
    expect(acceptsExamplesOf(PATH, doc(" * Add an @accepts tag."), "ProjectName")).toEqual([]);
  });

  test("refuses a non-literal, or a literal of the wrong type", () => {
    expect(() => acceptsExamplesOf(PATH, doc(" * @accepts Website"), "ProjectName")).toThrow(/not a literal/);
    expect(() => acceptsExamplesOf(PATH, doc(" * @accepts 42"), "ProjectName")).toThrow(/is not a string/);
    expect(() => acceptsExamplesOf(PATH, doc(' * @accepts "x" and more'), "ProjectName")).toThrow(DomainConceptError);
  });

  test("refuses @accepts on an entity", () => {
    const c = exampleConcept("project");
    const source = c.contract.replace("export interface Project {", '/** @accepts "x" */\nexport interface Project {');
    expect(() => acceptsExamplesOf(c.contractPath, source, "Project")).toThrow(/means nothing/);
  });
});

describe("refusals", () => {
  const cases: [string, string, string, RegExp][] = [
    ["a path outside the layout", "src/domain/project-name.contract.ts", vo(VO_MEMBERS), /contexts\/<context>\/src\/domain/],
    ["the retired declare class", PATH, 'export declare class ProjectName {\n  private readonly __brand: "ProjectName";\n  static parse(raw: unknown): ProjectName | undefined;\n}\n', /declares exactly/],
    ["a syntax error", PATH, vo(VO_MEMBERS).replace("}", ""), /does not parse/],
    ["a name that is not the file's", "contexts/pm/src/domain/projects/project-title.contract.ts", vo(VO_MEMBERS), /declares 'ProjectName'/],
    ["a third declaration", PATH, `${vo(VO_MEMBERS)}export type Alias = string;\n`, /declares exactly/],
    ["an unexported factory", PATH, vo(VO_MEMBERS).replace("export interface ProjectNameFactory", "interface ProjectNameFactory"), /declares exactly/],
    ["no factory", PATH, `import type { Result } from "../shared/result.ts";\nexport interface ProjectName {\n  ${VO_MEMBERS}\n}\n`, /no 'export interface ProjectNameFactory'/],
    ["a generic instance", PATH, vo(VO_MEMBERS).replace("interface ProjectName {", "interface ProjectName<T> {"), /generic or extends/],
    ["an extending instance", PATH, vo(VO_MEMBERS).replace("interface ProjectName {", "interface ProjectName extends Base {"), /generic or extends/],
    ["a value import", PATH, vo(VO_MEMBERS, undefined, 'import { Result } from "../shared/result.ts";'), /import type/],
    ["an implementation import", PATH, vo(VO_MEMBERS, undefined, 'import type { Result } from "../shared/result.ts";\nimport type { ProjectId } from "./project-id.ts";'), /imports only other domain contracts/],
    ["the domain barrel", PATH, vo(VO_MEMBERS, undefined, 'import type { Result } from "@example/pm/domain";'), /imports only other domain contracts/],
    ["an aliased import", PATH, vo(VO_MEMBERS, undefined, 'import type { Result as R } from "../shared/result.ts";'), /no alias/],
    ["a duplicate import", PATH, vo(VO_MEMBERS, undefined, 'import type { Result } from "../shared/result.ts";\nimport type { Result } from "../shared/result.ts";'), /imported twice/],
    ["the brand missing", PATH, vo('readonly value: string;\n  equals(other: ProjectName): boolean;\n  toJSON(): string;'), /first member must be 'readonly __brand: "ProjectName";'/],
    ["the brand mismatched", PATH, vo(VO_MEMBERS.replace('"ProjectName";', '"Name";')), /__brand/],
    ["a mutable field", PATH, vo(VO_MEMBERS.replace("readonly value", "value")), /must be readonly/],
    ["an optional method", PATH, vo(VO_MEMBERS.replace("toJSON()", "toJSON?()")), /is optional/],
    ["an overload", PATH, vo(`${VO_MEMBERS}\n  toJSON(): string;`), /declared twice/],
    ["an accessor", PATH, vo(`${VO_MEMBERS}\n  get upper(): string;`), /not a field or a method/],
    ["no equals", PATH, vo('readonly __brand: "ProjectName";\n  readonly value: string;\n  toJSON(): string;'), /equals\(other: ProjectName\): boolean/],
    ["no toJSON", PATH, vo('readonly __brand: "ProjectName";\n  readonly value: string;\n  equals(other: ProjectName): boolean;'), /toJSON\(\)/],
    ["toJSON of another type", PATH, vo(VO_MEMBERS.replace("toJSON(): string", "toJSON(): number")), /toJSON\(\): string/],
    ["two fields", PATH, vo(`${VO_MEMBERS}\n  readonly slug: string;`), /exactly one field/],
    ["a non-primitive value", PATH, vo(VO_MEMBERS.replace("readonly value: string", "readonly value: Date")), /exactly one field/],
    ["parse returning undefined", PATH, vo(VO_MEMBERS, "parse(raw: unknown): ProjectName | undefined;"), /parse\(raw: unknown\): Result<ProjectName>/],
    ["parse of a string", PATH, vo(VO_MEMBERS, "parse(raw: string): Result<ProjectName>;"), /parse\(raw: unknown\)/],
    ["parse with a renamed parameter", PATH, vo(VO_MEMBERS, "parse(input: unknown): Result<ProjectName>;"), /parse\(raw: unknown\)/],
    ["parse without Result imported", PATH, vo(VO_MEMBERS, undefined, ""), /import type \{ Result \}/],
    ["an optional parse parameter", PATH, vo(VO_MEMBERS, "parse(raw?: unknown): Result<ProjectName>;"), /plain 'name: Type'/],
    ["a generate that takes input", PATH, vo(VO_MEMBERS, "parse(raw: unknown): Result<ProjectName>;\n  generate(seed: string): ProjectName;"), /generate\(\): ProjectName/],
    ["an extra factory method", PATH, vo(VO_MEMBERS, "parse(raw: unknown): Result<ProjectName>;\n  of(a: string): ProjectName;"), /holds 'parse'/],
    ["a factory property", PATH, vo(VO_MEMBERS, "parse(raw: unknown): Result<ProjectName>;\n  readonly max: number;"), /a factory holds/],
  ];
  test.each(cases)("%s", (_label, path, source, message) => {
    const text = refusal(path, source);
    expect(text.startsWith(`${path}: `)).toBe(true);
    expect(text).toMatch(message);
  });

  const entity = exampleConcept("project");
  const entityCases: [string, string, RegExp][] = [
    ["construct params out of order", entity.contract.replace("new (id: ProjectId, name: ProjectName)", "new (name: ProjectName, id: ProjectId)"), /must take Project's fields in declaration order/],
    ["a construct param missing", entity.contract.replace("new (id: ProjectId, name: ProjectName)", "new (id: ProjectId)"), /fields in declaration order/],
    ["a construct returning another type", entity.contract.replace("): Project;\n}", "): ProjectId;\n}"), /construct signature must return 'Project'/],
    ["two constructors", entity.contract.replace("new (id: ProjectId, name: ProjectName): Project;", "new (id: ProjectId, name: ProjectName): Project;\n  new (id: ProjectId, name: ProjectName): Project;"), /exactly one 'new/],
    ["a parse beside the constructor", entity.contract.replace("new (id: ProjectId, name: ProjectName): Project;", "new (id: ProjectId, name: ProjectName): Project;\n  parse(raw: unknown): Project;"), /exactly one 'new/],
    ["identity not first", entity.contract.replace("readonly id: ProjectId;\n  readonly name: ProjectName;", "readonly name: ProjectName;\n  readonly id: ProjectId;").replace("new (id: ProjectId, name: ProjectName)", "new (name: ProjectName, id: ProjectId)"), /first field must be its identity/],
    ["a primitive field", entity.contract.replace("readonly name: ProjectName;", "readonly name: string;").replace("name: ProjectName)", "name: string)"), /imported value objects and identifiers only/],
    ["a field of an unimported type", entity.contract.replace("readonly name: ProjectName;", "readonly name: Title;").replace("name: ProjectName)", "name: Title)"), /imported value objects and identifiers only/],
    ["toJSON missing a field", entity.contract.replace("toJSON(): { readonly id: string; readonly name: string };", "toJSON(): { readonly id: string };"), /one readonly primitive per field/],
    ["toJSON with a concept", entity.contract.replace("toJSON(): { readonly id: string; readonly name: string };", "toJSON(): { readonly id: ProjectId; readonly name: string };"), /one readonly primitive per field/],
  ];
  test.each(entityCases)("entity: %s", (_label, source, message) => {
    expect(refusal(entity.contractPath, source)).toMatch(message);
  });
});
