import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runScaffold } from "../../scripts/scaffold-project.ts";
import { CONTEXT_SRC, type Fixture, pipelineProject, placeStage } from "../../scripts/pipeline-fixture.test-support.ts";
import { createSrcLinter } from "../../scripts/lint-src.ts";

// Issue #36: tests whose only subjects are generated code (a command, an in
// adapter) are refused on the test file, before red. The rule reads the
// project, so each case lints a source as if it lived in the scaffolded
// notebook fixture: `create-note.command.ts`, the application barrel and the
// tRPC in adapter are generated there; the handler and the concepts are not.

const RULE = "bounded-ts/no-generated-subject";
const FEATURE = `${CONTEXT_SRC}/application/notes/create-note`;
let f: Fixture;

beforeAll(() => {
  f = pipelineProject(["design"]);
  expect(runScaffold(f.dir).code).toBe(0);
  placeStage(f.dir, "tests", f.scope);
});
afterAll(() => f.cleanup());

async function problems(path: string, source: string): Promise<{ line: number; message: string }[]> {
  const [result] = await createSrcLinter(f.dir).lintText(source.replaceAll("@demo", f.scope), { filePath: join(f.dir, path) });
  return result!.messages.filter((m) => m.ruleId === RULE).map((m) => ({ line: m.line, message: m.message }));
}

const HEADER = `import { describe, expect, test, beforeEach } from "bun:test";
import { CreateNoteCommand } from "./create-note.command.ts";
import type { CreateNoteStore } from "./create-note.contract.ts";
import { CreateNoteHandler } from "./create-note.handler.ts";
const store: CreateNoteStore = { save: async () => {} };
`;

describe("refuses", () => {
  test("a test that only parses a generated command, naming the command and the fix", async () => {
    const found = await problems(`${FEATURE}/create-note.test.ts`, `${HEADER}
describe("CreateNoteCommand.parse", () => {
  test("refuses input that is not an object", () => {
    expect(CreateNoteCommand.parse("x")).toEqual({ ok: false, error: "Invalid create note input" });
  });
});
describe("CreateNoteHandler", () => {
  test("saves", async () => {
    const parsed = CreateNoteCommand.parse({ text: "a" });
    if (parsed.ok) await new CreateNoteHandler(store).execute(parsed.value);
  });
});
`);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(8);
    expect(found[0]!.message).toContain("only generated code (CreateNoteCommand from ./create-note.command.ts)");
    expect(found[0]!.message).toMatch(/Remove it/);
    expect(found[0]!.message).toContain("*.laws.test.ts");
  });

  test("a test that reaches the command only through a module helper", async () => {
    const found = await problems(`${FEATURE}/create-note.test.ts`, `${HEADER}
const parse = (raw: unknown) => CreateNoteCommand.parse(raw);
test("refuses a number", () => { expect(parse(1).ok).toBe(false); });
test("creates", async () => { await new CreateNoteHandler(store).execute(parse({ text: "a" }) as never); });
`);
    expect(found.map((p) => p.line)).toEqual([8]);
  });

  test("a test file whose every import is generated, once, at the first import", async () => {
    const found = await problems(`${FEATURE}/create-note.command-extra.test.ts`, `import { expect, test } from "bun:test";
import { CreateNoteCommand, createNoteSchema } from "./create-note.command.ts";
test("a", () => { expect(CreateNoteCommand.parse(1).ok).toBe(false); });
test("b", () => { expect(createNoteSchema.safeParse(1).success).toBe(false); });
`);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(2);
    expect(found[0]!.message).toMatch(/Every module this test file exercises is generated .*Delete this file/);
  });

  test("a command reached through the generated application barrel", async () => {
    const found = await problems(`${CONTEXT_SRC}/adapters/out/in-memory/notes/command.test.ts`, `import { expect, test } from "bun:test";
import { CreateNoteCommand } from "@demo/notebook/application";
test("a", () => { expect(CreateNoteCommand.parse(1).ok).toBe(false); });
`);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("CreateNoteCommand from @demo/notebook/application");
  });

  test("an app test that drives a generated in adapter with a fake in port", async () => {
    const found = await problems("apps/web/src/server/router.test.ts", `import { expect, test } from "bun:test";
import { createNotebookRouter } from "@demo/notebook/adapters/trpc";
test("lists", async () => {
  const router = createNotebookRouter({ createNote: { execute: async () => { throw new Error("x"); } }, listNotes: { execute: async () => [] } });
  expect(await router.createCaller({}).notes.list()).toEqual([]);
});
`);
    expect(found).toHaveLength(1);
  });
});

describe("allows", () => {
  test("the fixture's own tests, including a handler test that builds its input with the command", async () => {
    for (const path of [`${FEATURE}/create-note.test.ts`, `${CONTEXT_SRC}/domain/notes/note.test.ts`,
      `${CONTEXT_SRC}/adapters/out/in-memory/notes/create-note.store.test.ts`, "apps/web/src/server/composition-root.test.ts"]) {
      expect(await problems(path, readFileSync(join(f.dir, path), "utf8")), path).toEqual([]);
    }
  });

  test("a handler built in beforeEach, with the command parsed in the test", async () => {
    expect(await problems(`${FEATURE}/create-note.test.ts`, `${HEADER}
let handler: CreateNoteHandler;
beforeEach(() => { handler = new CreateNoteHandler(store); });
test("creates", async () => {
  const parsed = CreateNoteCommand.parse({ text: "a" });
  if (parsed.ok) expect((await handler.execute(parsed.value)).text.value).toBe("a");
});
`)).toEqual([]);
  });

  test("a describe-level handler, and a concept reached through the domain barrel", async () => {
    expect(await problems(`${FEATURE}/create-note.test.ts`, `${HEADER}
import { NoteText } from "@demo/notebook/domain";
describe("CreateNoteHandler", () => {
  const handler = new CreateNoteHandler(store);
  test("creates", async () => { await handler.execute(CreateNoteCommand.parse({ text: "a" }) as never); });
});
test("text", () => { expect(NoteText.parse("a").ok).toBe(true); });
`)).toEqual([]);
  });

  test("a command named only as a type", async () => {
    expect(await problems(`${FEATURE}/create-note.test.ts`, `import { expect, test } from "bun:test";
import type { CreateNoteCommand } from "./create-note.command.ts";
import { CreateNoteHandler } from "./create-note.handler.ts";
test("creates", async () => {
  const command: CreateNoteCommand | undefined = undefined;
  expect(new CreateNoteHandler({ save: async () => {} })).toBeDefined();
  expect(command).toBeUndefined();
});
`)).toEqual([]);
  });

  test("a test that reaches no project code at all", async () => {
    expect(await problems(`${FEATURE}/create-note.test.ts`, `import { expect, test } from "bun:test";
test("arithmetic", () => { expect(1 + 1).toBe(2); });
`)).toEqual([]);
  });
});
