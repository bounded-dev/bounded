import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { EXAMPLE_CONTEXT, exampleContracts, exampleFacts } from "./example-suite/example-facts.ts";
import { ContractShapeError, parseFeatureContract } from "./ts-hexagonal/pack.ts";
import { depsFunctionHead, featureContracts, importLine, listing, pluralVariable } from "./ts-trpc/scripts/in-adapter-kit.ts";

// The kit is copied into ts-trpc, ts-mcp and ts-lambda because a pack may
// import only across its declared edges (the file's header says why). Three
// copies of one file drift, so this test holds them byte-identical.
describe("the in-adapter kit", () => {
  const packs = import.meta.dirname;
  const copy = (pack: string): string => readFileSync(join(packs, pack, "scripts", "in-adapter-kit.ts"), "utf8");

  test("is one file in three packs", () => {
    expect(copy("ts-mcp")).toBe(copy("ts-trpc"));
    expect(copy("ts-lambda")).toBe(copy("ts-trpc"));
  });

  test("and so is the apps initializer", () => {
    const seed = (pack: string): string => readFileSync(join(packs, pack, "scripts", "seed-apps.ts"), "utf8");
    expect(seed("ts-mcp")).toBe(seed("ts-trpc"));
    expect(seed("ts-lambda")).toBe(seed("ts-trpc"));
  });
});

describe("the kit reads the worked example through ts-hexagonal's parser", () => {
  const features = featureContracts(exampleFacts());

  test("each model is exactly what the hexagonal parser returns", () => {
    const direct = exampleContracts()
      .filter((c) => /\/application\/[^/]+\/[^/]+\/[^/]+\.contract\.ts$/.test(c.path))
      .map((c) => parseFeatureContract(c.path, c.source, { scope: "@example" }));
    expect(features).toEqual(direct);
  });

  test("every feature, with its tags, input and return shape", () => {
    expect(features.map((f) => [f.area, f.feature, f.kind, f.exposedVia.join(" "), f.inPort.returns.shape, f.inPort.returns.result, f.input?.fields.length ?? 0]))
      .toEqual([
        ["notes", "create-note", "command", "trpc", "value", true, 2],
        ["notes", "list-notes", "query", "trpc", "array", false, 0],
        ["projects", "create-project", "command", "trpc mcp", "value", false, 1],
        ["projects", "export-projects", "command", "lambda", "void", false, 0],
        ["projects", "list-projects", "query", "trpc mcp", "array", false, 0],
      ]);
  });

  test("the create-note model in full", () => {
    const createNote = features[0]!;
    expect(createNote.input).toEqual({
      inputName: "CreateNoteInput", commandName: "CreateNoteCommand", commandFactoryName: "CreateNoteCommandFactory",
      schemaName: "createNoteSchema",
      fields: [{ name: "projectId", wireType: "string", concept: "ProjectId" }, { name: "text", wireType: "string", concept: "NoteText" }],
    });
    expect(createNote.doc).toBe("Create a note");
    expect(createNote.domainTypes).toEqual(["Note", "NoteText", "ProjectId"]);
    expect(createNote.outPorts.map((p) => [p.name, p.role, p.isStore])).toEqual([["CreateNoteStore", "store", true]]);
  });

  test("out ports keep declaration order and their @implementedBy ids", () => {
    const exported = features.find((f) => f.feature === "export-projects")!;
    expect(exported.outPorts.map((p) => [p.name, p.role, p.isStore, p.implementedBy])).toEqual([
      ["ExportProjectsStore", "store", true, []],
      ["ProjectExporter", "exporter", false, ["console"]],
    ]);
  });

  const path = `${EXAMPLE_CONTEXT}/src/application/notes/list-notes/list-notes.contract.ts`;
  const withEdit = (target: string, edit: (s: string) => string) => exampleFacts({
    contracts: exampleContracts().map((c) => (c.path === path ? { path: target, source: edit(c.source) } : c)),
  });

  test("a contract the parser refuses stops the kit, naming the file", () => {
    const refused = withEdit(path, (s) => s.replace("Promise<Note[]>;\n}", "Promise<string>;\n}"));
    expect(() => featureContracts(refused)).toThrow(ContractShapeError);
    expect(() => featureContracts(refused)).toThrow(/list-notes\.contract\.ts/);
  });

  test("a misnamed feature contract is refused, not skipped", () => {
    const misnamed = withEdit(path.replace("list-notes.contract.ts", "listing.contract.ts"), (s) => s);
    expect(() => featureContracts(misnamed)).toThrow(/must be named 'list-notes\.contract\.ts'/);
  });
});

describe("printing", () => {
  test("an import breaks at the width, values before types", () => {
    expect(importLine(["b", "A"], ["C"], "x")).toBe('import { A, b, type C } from "x";');
    expect(importLine([], ["B", "A"], "x")).toBe('import type { A, B } from "x";');
    const long = importLine(["CreateProjectCommand", "createProjectSchema"], ["CreateProject"], "@example/project-management/application");
    expect(long).toBe('import {\n  CreateProjectCommand,\n  createProjectSchema,\n  type CreateProject,\n} from "@example/project-management/application";');
  });

  test("a deps parameter breaks one member per line", () => {
    expect(depsFunctionHead("f", [["a", "A"]])).toBe("export function f(deps: { a: A }) {");
    const members = Array.from({ length: 6 }, (_, i) => [`dependencyNumber${i}`, `DependencyNumber${i}`] as const);
    expect(depsFunctionHead("f", members).split("\n")).toEqual([
      "export function f(deps: {", ...members.map(([k, v]) => `  ${k}: ${v};`), "}) {",
    ]);
  });

  test("plurals and listings", () => {
    expect(["Project", "Address", "Category", "Day", "Command"].map(pluralVariable))
      .toEqual(["projects", "addresses", "categories", "days", "commands"]);
    expect([[], ["a.*"], ["a.*", "b.*"], ["a.*", "b.*", "c.*"]].map(listing)).toEqual(["", "a.*", "a.* and b.*", "a.*, b.* and c.*"]);
  });
});
