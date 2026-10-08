import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { installPathGate } from "./extensions/path-gate.ts";
import { resetPathGateRegistry } from "../../src/path-gate.ts";
import { makeTempProject, type TempProject } from "../../test/support/temp-project.ts";

// ADR LEG-2026-057 on pi: a blind role's content search is judged on its file
// glob, and a find on its pattern. pi's own grep takes `glob` and its find
// takes `pattern`, and the extension hands the tool call's input to the gate
// unchanged — this file pins that the fields arrive, so the gate judges the
// call that will run. (It lives here, not beside the extension, because pi
// loads every top-level file in extensions/ as an extension.) The project
// composes the hexagonal layout pack, which contributes the source roots.

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    getActiveTools: () => ["read", "grep", "find", "ls", "write", "edit"],
    setActiveTools() {},
    registerTool() {},
  };
  return {
    pi: pi as unknown as Parameters<typeof installPathGate>[0],
    async call(cwd: string, toolName: string, input: Record<string, unknown>): Promise<{ block: true; reason: string } | undefined> {
      for (const h of handlers.get("tool_call") ?? []) {
        const r = await h({ toolName, input }, { cwd, modelRegistry: undefined });
        if (r !== undefined) return r as { block: true; reason: string };
      }
      return undefined;
    },
  };
}

const C = "contexts/notes/src";
const projects: TempProject[] = [];
function project(): string {
  const p = makeTempProject({
    [`${C}/domain/note.ts`]: "export {};\n",
    [`${C}/domain/note.test.ts`]: "test('x', () => {});\n",
  }, { prefix: "pi-forward-", packs: ["ts", "ts-hexagonal"] });
  projects.push(p);
  return p.dir;
}
beforeEach(() => {
  resetPathGateRegistry();
  vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
  vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", undefined);
  vi.stubEnv("BOUNDED_GUARD_LOG", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetPathGateRegistry();
  while (projects.length) projects.pop()?.cleanup();
});

describe("the pi path gate judges a search on the filter it will run with", () => {
  test("builder grep: the glob decides, so it must have arrived", async () => {
    const dir = project();
    const fake = fakePi();
    installPathGate(fake.pi, "builder", { projectCopy: false });
    const path = join(dir, C);
    expect((await fake.call(dir, "grep", { pattern: "x", path }))?.reason).toContain("can reach test files");
    expect(await fake.call(dir, "grep", { pattern: "x", path, glob: "*.note.ts" })).toBeUndefined();
    expect((await fake.call(dir, "grep", { pattern: "x", path, glob: "*.ts" }))?.reason).toContain("could match a test file name");
  });

  test("test-writer grep: only a glob that reaches tests", async () => {
    const dir = project();
    const fake = fakePi();
    installPathGate(fake.pi, "test-writer", { projectCopy: false });
    const path = join(dir, C);
    expect(await fake.call(dir, "grep", { pattern: "x", path, glob: "*.test.ts" })).toBeUndefined();
    expect((await fake.call(dir, "grep", { pattern: "x", path }))?.block).toBe(true);
  });

  test("find: names of the other side are fine, a pattern that climbs out is not", async () => {
    const dir = project();
    const fake = fakePi();
    installPathGate(fake.pi, "builder", { projectCopy: false });
    const path = join(dir, C);
    expect(await fake.call(dir, "find", { pattern: "**/*.test.ts", path })).toBeUndefined();
    expect((await fake.call(dir, "find", { pattern: "../../**", path }))?.block).toBe(true);
  });

  test("reads of the other side are refused on pi as on every host", async () => {
    const dir = project();
    const fake = fakePi();
    installPathGate(fake.pi, "builder", { projectCopy: false });
    expect((await fake.call(dir, "read", { path: join(dir, C, "domain/note.test.ts") }))?.reason).toContain("it is a test file");
    expect(await fake.call(dir, "read", { path: join(dir, C, "domain/note.ts") })).toBeUndefined();
  });
});
