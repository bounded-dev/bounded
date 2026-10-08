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
import { DOMAIN_REFUSALS, REFUSAL_PATH as PATH, vo, VO_MEMBERS } from "./testdata/domain-refusals.ts";

// The domain-concept parser (ADR LEG-2026-059, TN-26-012 §3): the worked
// example's six contracts parse to the model every emitter codes against, and
// every shape outside the grammar is refused with the contract path and a fix.

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
  test.each(DOMAIN_REFUSALS.map((c) => [c.label, c] as const))("%s", (_label, c) => {
    const text = refusal(c.path, c.source);
    expect(text.startsWith(`${c.path}: `)).toBe(true);
    expect(text).toMatch(c.parser);
  });
});
