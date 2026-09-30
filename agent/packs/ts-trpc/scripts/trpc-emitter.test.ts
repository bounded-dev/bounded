import { describe, expect, test } from "vitest";
import { emittedFileProblem } from "../../ts/pack.ts";
import { pathGlobMatcher, generatedFileGlobsFor } from "../../../src/pack-contrib.ts";
import { EXAMPLE_CONTEXT, exampleContracts, exampleFacts, exampleFiles, readExample, withoutComments } from "../../example-suite/example-facts.ts";
import { emitTrpcAdapters, trpcAdapterEmitter } from "./trpc-emitter.ts";

// The golden (TN-26-012 §6, WI-7): emitting from the worked example's feature
// contracts, tagged as TN-26-012 §4 records, reproduces the example's
// adapters/in/trpc/** — byte for byte, comments included.

const DIR = `${EXAMPLE_CONTEXT}/src/adapters/in/trpc`;

describe("the tRPC in adapter of the worked example", () => {
  const emitted = emitTrpcAdapters(exampleFacts());
  const adapters = emitted.filter((f) => !f.path.endsWith(".laws.test.ts"));

  test("is exactly the example's files, byte for byte", () => {
    expect(adapters.map((f) => f.path)).toEqual(exampleFiles(DIR));
    for (const file of adapters) expect(file.content, file.path).toBe(readExample(file.path));
  });

  test("adds one law file per procedure, beside it", () => {
    expect(emitted.filter((f) => f.path.endsWith(".laws.test.ts")).map((f) => f.path)).toEqual([
      `${DIR}/notes/create-note.procedure.laws.test.ts`,
      `${DIR}/notes/list-notes.procedure.laws.test.ts`,
      `${DIR}/projects/create-project.procedure.laws.test.ts`,
      `${DIR}/projects/list-projects.procedure.laws.test.ts`,
    ]);
  });

  test("every file is generated, well-formed and write-protected by a composed glob", () => {
    const generated = pathGlobMatcher(generatedFileGlobsFor(["ts", "ts-hexagonal", "ts-trpc"]));
    for (const file of emitted) {
      expect(emittedFileProblem(file, trpcAdapterEmitter.name), file.path).toBeUndefined();
      expect(file.mode).toBe("generated");
      expect(generated(file.path), file.path).toBe(true);
    }
  });

  test("is pure: the same facts give the same bytes", () => {
    expect(emitTrpcAdapters(exampleFacts())).toEqual(emitted);
  });

  test("comparison modulo comments holds too (the TN's own measure)", () => {
    for (const file of adapters) expect(withoutComments(file.content)).toBe(withoutComments(readExample(file.path)));
  });
});

/** The example's contracts with one feature's source replaced. */
function withContract(path: string, edit: (source: string) => string) {
  return exampleContracts().map((c) => (c.path === path ? { ...c, source: edit(c.source) } : c));
}

const CREATE_NOTE = `${EXAMPLE_CONTEXT}/src/application/notes/create-note/create-note.contract.ts`;
const LIST_NOTES = `${EXAMPLE_CONTEXT}/src/application/notes/list-notes/list-notes.contract.ts`;

describe("the shapes the example does not show", () => {
  const procedure = (contracts: ReturnType<typeof exampleContracts>, feature: string): string =>
    emitTrpcAdapters(exampleFacts({ contracts })).find((f) => f.path.endsWith(`/${feature}.procedure.ts`))!.content;

  test("a query returning one concept maps it through toJSON", () => {
    const contracts = withContract(LIST_NOTES, (s) => s.replace("execute(): Promise<Note[]>;", "execute(): Promise<Note>;"));
    expect(procedure(contracts, "list-notes")).toContain(
      "export const listNotesProcedure = (listNotes: ListNotes) =>\n  t.procedure.query(async () => (await listNotes.execute()).toJSON());\n",
    );
  });

  test("a Result of an array maps the success and passes the failure", () => {
    const contracts = withContract(LIST_NOTES, (s) => s
      .replace('import type { Note } from', 'import type { Note, Result } from')
      .replace("execute(): Promise<Note[]>;", "execute(): Promise<Result<Note[]>>;"));
    expect(procedure(contracts, "list-notes")).toBe([
      'import type { ListNotes } from "@example/project-management/application";',
      'import { t } from "../trpc.ts";',
      "",
      "export const listNotesProcedure = (listNotes: ListNotes) =>",
      "  t.procedure.query(async () => {",
      "    const result = await listNotes.execute();",
      "    return result.ok ? { ok: true as const, value: result.value.map((note) => note.toJSON()) } : result;",
      "  });",
      "",
    ].join("\n"));
  });

  test("a command returning void answers ok with no value", () => {
    const contracts = withContract(CREATE_NOTE, (s) => s.replace("Promise<Result<Note>>", "Promise<void>"));
    expect(procedure(contracts, "create-note")).toContain([
      "    await createNote.execute(command.value);",
      "    return { ok: true as const, value: undefined };",
    ].join("\n"));
  });

  test("an input-less command without a result runs execute and returns nothing", () => {
    const contracts = withContract(LIST_NOTES, (s) => s.replace("execute(): Promise<Note[]>;", "execute(): Promise<void>;"));
    // `list-notes` is a query by its verb, whatever it returns.
    expect(procedure(contracts, "list-notes")).toContain("  t.procedure.query(async () => {\n    await listNotes.execute();\n  });");
  });

  test("a feature not tagged trpc gets no procedure, and a context with none gets no adapter", () => {
    const untagged = withContract(LIST_NOTES, (s) => s.replace(" * @exposedVia trpc\n", ""));
    expect(emitTrpcAdapters(exampleFacts({ contracts: untagged })).some((f) => f.path.includes("list-notes"))).toBe(false);
    const none = exampleContracts().map((c) => ({ ...c, source: c.source.replace(/@exposedVia [a-z ]+/, "@exposedVia lambda") }));
    expect(emitTrpcAdapters(exampleFacts({ contracts: none }))).toEqual([]);
  });
});

describe("refusals", () => {
  test("an @exposedVia id that is not a composed in technology", () => {
    const contracts = withContract(LIST_NOTES, (s) => s.replace("@exposedVia trpc", "@exposedVia trpc graphql"));
    expect(() => emitTrpcAdapters(exampleFacts({ contracts }))).toThrow(/list-notes\.contract\.ts: @exposedVia names 'graphql'/);
  });

  test("two features with one route key in an area", () => {
    const contracts = [
      ...exampleContracts(),
      {
        path: `${EXAMPLE_CONTEXT}/src/application/notes/list-note/list-note.contract.ts`,
        source: 'import type { Note } from "@example/project-management/domain";\n\n/**\n * @exposedVia trpc\n */\nexport interface ListNote {\n  execute(): Promise<Note[]>;\n}\n',
      },
    ];
    expect(() => emitTrpcAdapters(exampleFacts({ contracts }))).toThrow(/route key 'notes\.list'/);
  });

  test("a contract outside the grammar names the file and the fix", () => {
    const contracts = withContract(CREATE_NOTE, (s) => s.replace("readonly text: string;", "readonly text?: string;"));
    expect(() => emitTrpcAdapters(exampleFacts({ contracts }))).toThrow(/create-note\.contract\.ts: optional field text is refused/);
  });
});
