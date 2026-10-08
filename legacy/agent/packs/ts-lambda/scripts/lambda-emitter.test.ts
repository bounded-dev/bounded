import { describe, expect, test } from "vitest";
import { emittedFileProblem } from "../../ts/pack.ts";
import { generatedFileGlobsFor, pathGlobMatcher } from "../../../src/pack-contrib.ts";
import {
  EXAMPLE_CONTEXT,
  exampleContracts,
  exampleFacts,
  exampleFiles,
  readExample,
  withoutComments,
} from "../../example-suite/example-facts.ts";
import { emitLambdaAdapters, lambdaAdapterEmitter } from "./lambda-emitter.ts";

// The golden (TN-26-012 §6, WI-7): the worked example's feature contracts,
// tagged as TN-26-012 §4 records, reproduce its adapters/in/lambda/**. The
// example's one comment line is feature-specific prose, so the handler file
// is compared modulo comments (the TN's measure); the barrel byte for byte.

const DIR = `${EXAMPLE_CONTEXT}/src/adapters/in/lambda`;

describe("the Lambda in adapter of the worked example", () => {
  const emitted = emitLambdaAdapters(exampleFacts());
  const adapters = emitted.filter((f) => !f.path.endsWith(".laws.test.ts"));

  test("is the example's files", () => {
    expect(adapters.map((f) => f.path)).toEqual(exampleFiles(DIR));
    for (const file of adapters) expect(withoutComments(file.content), file.path).toBe(withoutComments(readExample(file.path)));
    expect(adapters.find((f) => f.path.endsWith("index.ts"))!.content).toBe(readExample(`${DIR}/index.ts`));
  });

  test("adds one law file per handler, and every file is generated and write-protected", () => {
    expect(emitted.filter((f) => f.path.endsWith(".laws.test.ts")).map((f) => f.path))
      .toEqual([`${DIR}/projects/export-projects.lambda.laws.test.ts`]);
    const generated = pathGlobMatcher(generatedFileGlobsFor(["ts", "ts-hexagonal", "ts-lambda"]));
    for (const file of emitted) {
      expect(emittedFileProblem(file, lambdaAdapterEmitter.name), file.path).toBeUndefined();
      expect(generated(file.path), file.path).toBe(true);
    }
  });
});

const EXPORT = `${EXAMPLE_CONTEXT}/src/application/projects/export-projects/export-projects.contract.ts`;
const CREATE_NOTE = `${EXAMPLE_CONTEXT}/src/application/notes/create-note/create-note.contract.ts`;
const withContract = (path: string, edit: (source: string) => string) =>
  exampleContracts().map((c) => (c.path === path ? { ...c, source: edit(c.source) } : c));
const handler = (contracts: ReturnType<typeof exampleContracts>, feature: string): string =>
  emitLambdaAdapters(exampleFacts({ contracts })).find((f) => f.path.endsWith(`/${feature}.lambda.ts`))!.content;

describe("the shapes the example does not show", () => {
  test("a feature with input parses the event and answers a Result of plain data", () => {
    const contracts = withContract(CREATE_NOTE, (s) => s.replace("@exposedVia trpc", "@exposedVia trpc lambda"));
    expect(handler(contracts, "create-note")).toBe([
      'import { CreateNoteCommand, type CreateNote } from "@example/project-management/application";',
      "",
      "// Driving adapter: each invocation calls the in port once.",
      "export const createCreateNoteLambda = (deps: { notes: { create: CreateNote } }) => async (event: unknown) => {",
      "  const command = CreateNoteCommand.parse(event);",
      "  if (!command.ok) return command;",
      "  const result = await deps.notes.create.execute(command.value);",
      "  return result.ok ? { ok: true as const, value: result.value.toJSON() } : result;",
      "};",
      "",
    ].join("\n"));
  });

  test("an input-less feature returning concepts maps them", () => {
    const contracts = withContract(EXPORT, (s) => s.replace("execute(): Promise<void>;", "execute(): Promise<Project[]>;"));
    expect(handler(contracts, "export-projects")).toContain(
      "export const createExportProjectsLambda = (deps: { projects: { export: ExportProjects } }) => async () => {\n" +
      "  return (await deps.projects.export.execute()).map((project) => project.toJSON());\n};\n",
    );
  });
});
