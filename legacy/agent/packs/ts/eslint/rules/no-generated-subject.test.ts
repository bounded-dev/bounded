import { readFileSync, writeFileSync } from "node:fs";
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
  const router = createNotebookRouter({ notes: { create: { execute: async () => { throw new Error("x"); } }, list: { execute: async () => [] } } });
  expect(await router.createCaller({}).notes.list()).toEqual([]);
});
`);
    expect(found).toHaveLength(1);
  });

  // The composition root is generated too (ADR LEG-2026-067), but composeApp
  // constructs the builder's handlers and stores, so the smoke test reaches them.
  test("allows the app smoke test: composeApp builds authored handlers and stores", async () => {
    expect(await problems("apps/web/src/server/smoke.test.ts", `import { expect, test } from "bun:test";
import { composeApp } from "./composition-root.ts";
test("lists", async () => { expect(await composeApp().createCaller({}).notes.list()).toEqual([]); });
`)).toEqual([]);
  });

  test("only the imported binding counts: another export of the composition root that constructs nothing is refused", async () => {
    const path = join(f.dir, "apps/web/src/server/composition-root.ts");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, `${original}\nexport function rootLabel(): string {\n  return "web";\n}\n`);
    try {
      const found = await problems("apps/web/src/server/label.test.ts", `import { expect, test } from "bun:test";
import { rootLabel } from "./composition-root.ts";
test("label", () => { expect(rootLabel()).toBe("web"); });
`);
      expect(found).toHaveLength(1);
      expect(found[0]!.message).toContain("rootLabel from ./composition-root.ts");
    } finally {
      writeFileSync(path, original);
    }
  });

  test("importing composeApp does not excuse a test that uses only the generated router", async () => {
    const found = await problems("apps/web/src/server/router2.test.ts", `import { expect, test } from "bun:test";
import { createNotebookRouter } from "@demo/notebook/adapters/trpc";
import { composeApp } from "./composition-root.ts";
void composeApp;
test("lists", async () => {
  const router = createNotebookRouter({ notes: { create: { execute: async () => { throw new Error("x"); } }, list: { execute: async () => [] } } });
  expect(await router.createCaller({}).notes.list()).toEqual([]);
});
`);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("createNotebookRouter from @demo/notebook/adapters/trpc");
  });
});

// Review of #36: a test-side helper is followed into its own subjects, and
// whatever the analysis cannot see through counts as possibly authored.
describe("through helpers, parameters and runtime loads", () => {
  const support = (name: string, source: string): void => writeFileSync(join(f.dir, FEATURE, name), source.replaceAll("@demo", f.scope));

  test("allows a test whose handler comes from a test-support fixture (repro 1)", async () => {
    support("adv-fixture.test-support.ts", `import type { CreateNoteStore } from "./create-note.contract.ts";
import { CreateNoteHandler } from "./create-note.handler.ts";
const store: CreateNoteStore = { save: async () => {} };
export function makeHandler(): CreateNoteHandler { return new CreateNoteHandler(store); }
`);
    expect(await problems(`${FEATURE}/create-note.test.ts`, `import { expect, test } from "bun:test";
import { CreateNoteCommand } from "./create-note.command.ts";
import { makeHandler } from "./adv-fixture.test-support.ts";
test("creates", async () => {
  const parsed = CreateNoteCommand.parse({ text: "a" });
  if (parsed.ok) expect((await makeHandler().execute(parsed.value)).text.value).toBe("a");
});
`)).toEqual([]);
  });

  test("allows a conformance suite whose subject arrives as a parameter (repro 2)", async () => {
    expect(await problems(`${FEATURE}/create-note.store.test-support.ts`, `import { expect, test } from "bun:test";
import { CreateNoteCommand } from "./create-note.command.ts";
import type { CreateNoteStore } from "./create-note.contract.ts";
export function createNoteStoreConformance(make: () => Promise<{ store: CreateNoteStore }>): void {
  test("saves", async () => {
    const { store } = await make();
    expect(CreateNoteCommand.parse({ text: "a" }).ok).toBe(true);
    await store.save(undefined as never);
  });
}
`)).toEqual([]);
  });

  test("allows a test reaching a global the analysis does not know, a computed import, or an export * helper", async () => {
    support("star.test-support.ts", `export * from "./create-note.command.ts";\n`);
    expect(await problems(`${FEATURE}/create-note.test.ts`, `import { expect, test } from "bun:test";
import { CreateNoteCommand } from "./create-note.command.ts";
import { createNoteSchema } from "./star.test-support.ts";
declare const fixtureFromSetup: { ok: boolean };
test("a", () => { expect(CreateNoteCommand.parse(1).ok).toBe(fixtureFromSetup.ok); });
test("b", async () => { const name = "./x.ts"; await import(name); expect(CreateNoteCommand.parse(1).ok).toBe(false); });
test("c", () => { expect(createNoteSchema.safeParse(1).success).toBe(false); });
`)).toEqual([]);
  });

  test("refuses a command re-exported through a test-support file", async () => {
    support("commands.test-support.ts", `export { CreateNoteCommand } from "./create-note.command.ts";\n`);
    const found = await problems(`${FEATURE}/create-note.test.ts`, `${HEADER}
import { CreateNoteCommand as Command } from "./commands.test-support.ts";
test("refuses a number", () => { expect(Command.parse(1).ok).toBe(false); });
test("creates", async () => { await new CreateNoteHandler(store).execute(CreateNoteCommand.parse({ text: "a" }) as never); });
`);
    expect(found.map((p) => p.line)).toEqual([8]);
  });

  test("refuses a command loaded by a literal dynamic import", async () => {
    const found = await problems(`${FEATURE}/create-note.test.ts`, `${HEADER}
test("refuses a number", async () => {
  const { CreateNoteCommand: Command } = await import("./create-note.command.ts");
  expect(Command.parse(1).ok).toBe(false);
});
test("creates", async () => { await new CreateNoteHandler(store).execute(CreateNoteCommand.parse({ text: "a" }) as never); });
`);
    expect(found.map((p) => p.line)).toEqual([7]);
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
