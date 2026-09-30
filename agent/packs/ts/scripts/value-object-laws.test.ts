import { describe, expect, test } from "vitest";
import { acceptsExamplesOf, parseDomainConcept } from "./domain-concept.ts";
import type { DomainConceptModel } from "./feature-model.ts";
import { isGeneratedArtifact } from "./scaffold-contract.ts";
import {
  compareSpecifiers,
  conceptLawsSource,
  type ConceptSampleSource,
  hostileExpressionsFor,
  HOSTILE_INPUT_EXPRESSIONS,
  lawsPathFor,
  ValueObjectLawsError,
} from "./value-object-laws.ts";
import { EXAMPLE_CONCEPTS, exampleConcept } from "./testdata/example-domain.ts";

// The domain-concept law generator (ADR 2026-059): laws for every value
// object, identifier and entity, colocated as `<concept>.laws.test.ts` and run
// by `bun test`. Running them against real implementations is
// domain-emitter.test.ts's job; this file pins what is generated and why.

function withAccepts(stem: string, examples: readonly string[]): { path: string; source: string } {
  const c = exampleConcept(stem);
  const name = parseDomainConcept(c.contractPath, c.contract).name;
  const tags = examples.map((e) => ` * @accepts ${e}`).join("\n");
  return { path: c.contractPath, source: c.contract.replace(`export interface ${name} {`, `/**\n * Docs.\n${tags}\n */\nexport interface ${name} {`) };
}

function domain(overrides: { path: string; source: string }[] = []): Map<string, ConceptSampleSource> {
  const out = new Map<string, ConceptSampleSource>();
  for (const c of EXAMPLE_CONCEPTS) {
    const o = overrides.find((x) => x.path === c.contractPath);
    const source = o?.source ?? c.contract;
    const model = parseDomainConcept(c.contractPath, source);
    out.set(model.name, { model, examples: acceptsExamplesOf(c.contractPath, source, model.name) });
  }
  return out;
}

function lawsFor(name: string, concepts = domain()): string {
  const { model, examples } = concepts.get(name)!;
  return conceptLawsSource(model, examples, (n) => concepts.get(n));
}

describe("paths and ordering", () => {
  test("laws sit beside the contract", () => {
    expect(lawsPathFor("contexts/pm/src/domain/notes/note-id.contract.ts")).toBe("contexts/pm/src/domain/notes/note-id.laws.test.ts");
    expect(() => lawsPathFor("contexts/pm/src/domain/notes/note-id.ts")).toThrow(ValueObjectLawsError);
  });

  test("imports sort packages first, then paths with '.' before '-'", () => {
    const specs = ["./note-id.ts", "../shared/result.ts", "./note.ts", "bun:test", "../projects/project-id.ts", "./note-text.ts"];
    expect([...specs].sort(compareSpecifiers)).toEqual([
      "bun:test",
      "../projects/project-id.ts",
      "../shared/result.ts",
      "./note.ts",
      "./note-id.ts",
      "./note-text.ts",
    ]);
  });
});

describe("the hostile corpus", () => {
  test("cross-type inputs are hostile; same-type ordinary values are the test-writer's", () => {
    const forString = hostileExpressionsFor("string");
    expect(forString).not.toContain('""');
    expect(forString).not.toContain('" "');
    expect(forString).toContain("0");
    expect(forString).toContain("null");
    const forNumber = hostileExpressionsFor("number");
    expect(forNumber).toContain("NaN");
    expect(forNumber).toContain("Infinity");
    expect(forNumber).not.toContain("0");
    expect(forNumber).not.toContain("-1");
    expect(forNumber).toContain('""');
    const forBoolean = hostileExpressionsFor("boolean");
    expect(forBoolean).not.toContain("true");
    expect(forBoolean).toContain("0");
  });

  test("an @accepts example is never also asserted hostile", () => {
    expect(hostileExpressionsFor("number", ["NaN"])).not.toContain("NaN");
    expect(HOSTILE_INPUT_EXPRESSIONS).toContain("NaN");
  });
});

describe("value objects", () => {
  test("carry the generated marker the scaffolder's sync recognises", () => {
    const laws = lawsFor("NoteText");
    expect(laws.split("\n")[0]).toBe("// GENERATED from note-text.contract.ts by packs/ts/scripts/value-object-laws.ts — do not edit.");
    expect(isGeneratedArtifact(laws)).toBe(true);
  });

  test("without an example: hostile-input laws run, value laws are one named skip", () => {
    const laws = lawsFor("NoteText");
    expect(laws).toContain('import { NoteText } from "./note-text.ts";');
    expect(laws).toContain('test("parse refuses every hostile input"');
    expect(laws).toContain('test("parse gives a reason for every refusal"');
    expect(laws).toContain("test.skip(\"value laws need a valid NoteText — add an @accepts example to NoteText's contract\"");
    // nothing parses a sample, so neither the helper nor Result is imported
    expect(laws).not.toContain("mustParse");
    expect(laws).not.toContain("Result");
    // the string corpus, without same-type values
    expect(laws).toContain('["0", 0],');
    expect(laws).not.toContain('["\\"\\"", ""],');
  });

  test("with one example: the value laws run and discrimination is a named skip", () => {
    const concepts = domain([withAccepts("note-text", ['"Call the printer"'])]);
    const laws = lawsFor("NoteText", concepts);
    expect(laws).toContain('import type { Result } from "../shared/result.ts";');
    expect(laws).toContain('expect(NoteText.parse("Call the printer").ok).toBe(true);');
    expect(laws).toContain('test("toJSON round-trips through parse"');
    expect(laws).toContain('test("equals compares by value, not by reference"');
    expect(laws).toContain("test.skip(\"equals discriminates — add a second, different @accepts example to NoteText's contract\"");
  });

  test("with two different examples: equality discriminates them", () => {
    const laws = lawsFor("NoteText", domain([withAccepts("note-text", ['"Call the printer"', '"Book the venue"'])]));
    expect(laws).toContain('const other = mustParse(NoteText.parse("Book the venue"), "NoteText.parse(\\"Book the venue\\")");');
    expect(laws).not.toContain("test.skip");
  });

  test("an identifier samples itself with generate()", () => {
    const laws = lawsFor("ProjectId");
    expect(laws).toContain('describe("ProjectId — identifier laws (generated)"');
    expect(laws).toContain("const a = ProjectId.generate();");
    expect(laws).toContain("expect(ProjectId.generate().equals(ProjectId.generate())).toBe(false);");
    expect(laws).toContain('import type { Result } from "../shared/result.ts";');
    expect(laws).not.toContain("test.skip");
  });

  test("no law evaluates concept code at module load", () => {
    for (const name of ["NoteId", "NoteText", "Note", "ProjectName", "Project"]) {
      const laws = lawsFor(name, domain([withAccepts("note-text", ['"a"', '"b"']), withAccepts("project-name", ['"c"'])]));
      const topLevel = laws.split("\n").filter((l) => /^\S/.test(l) && !/^(import|\/\/|\/\*\*| \*|function|describe|const HOSTILE_INPUTS|}|\]|\);)/.test(l));
      expect(topLevel).toEqual([]);
    }
  });

  test("is deterministic", () => {
    expect(lawsFor("NoteId")).toBe(lawsFor("NoteId"));
  });
});

describe("entities", () => {
  test("without a sample for a field: one named skip naming the concept to document", () => {
    const laws = lawsFor("Note");
    expect(laws).toContain("test.skip(\"entity laws need a valid NoteText — add an @accepts example to NoteText's contract\"");
    expect(laws).not.toContain('from "./note.ts"');
  });

  test("with samples: identity, wire form and id round-trip laws, importing each field's implementation", () => {
    const laws = lawsFor("Note", domain([withAccepts("note-text", ['"Call the printer"', '"Book the venue"'])]));
    expect(laws).toContain(`import { describe, expect, test } from "bun:test";
import { ProjectId } from "../projects/project-id.ts";
import type { Result } from "../shared/result.ts";
import { Note } from "./note.ts";
import { NoteId } from "./note-id.ts";
import { NoteText } from "./note-text.ts";`);
    expect(laws).toContain('test("equals compares by identity, not by content"');
    expect(laws).toContain("const sameId = new Note(id, ProjectId.generate(), mustParse(NoteText.parse(\"Book the venue\")");
    expect(laws).toContain("const otherId = new Note(NoteId.generate(), projectId, text);");
    expect(laws).toContain("expect(a.equals(otherId)).toBe(false);");
    expect(laws).toContain("expect(json.projectId).toStrictEqual(projectId.toJSON());");
    expect(laws).toContain('expect(mustParse(ProjectId.parse(json.projectId), "ProjectId.parse(json.projectId)").equals(projectId)).toBe(true);');
    expect(laws).not.toContain("test.skip");
  });

  test("refuses a field whose concept the domain does not declare", () => {
    const concepts = domain([withAccepts("project-name", ['"x"'])]);
    concepts.delete("ProjectName");
    expect(() => lawsFor("Project", concepts)).toThrow(/Project\.name is 'ProjectName', which is not a concept contract in this domain/);
  });

  test("refuses a field that shadows a local the laws declare", () => {
    const concepts = domain([withAccepts("project-name", ['"x"'])]);
    const project = concepts.get("Project")!;
    const renamed: DomainConceptModel = {
      ...project.model,
      fields: project.model.fields.map((f) => (f.name === "name" ? { ...f, name: "json" } : f)),
    };
    expect(() => conceptLawsSource(renamed, [], (n) => concepts.get(n))).toThrow(/shadows a name the generated laws use/);
  });
});
