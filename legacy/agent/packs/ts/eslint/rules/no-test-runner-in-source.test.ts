import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noTestRunnerInSource } from "./no-test-runner-in-source.ts";

// The final review's repro: a builder file registering `mock.module` for the
// module under test turned a red suite green for every file loaded after it.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const at = "contexts/pm/src/domain/notes/note.ts";

ruleTester.run("no-test-runner-in-source", noTestRunnerInSource, {
  valid: [
    { code: 'import { z } from "zod";\nexport const mockModule = 1;', filename: at },
    { code: "const mock = { module: 1 };\nexport const x = mock;", filename: at },
    { code: "export const x = 1;", filename: "contexts/pm/src/domain/notes/test-data.ts" },
    { code: "export const x = 1;", filename: "contexts/pm/src/domain/notes/a_spec_.ts" },
  ],
  invalid: [
    {
      code: 'import { mock, test } from "bun:test";\nmock.module("./impl.ts", () => ({ add: (a: number, b: number) => a + b }));\ntest("x", () => {});',
      filename: "contexts/pm/src/domain/notes/a.spec.mts",
      errors: [{ messageId: "testName" }, { messageId: "testImport" }, { messageId: "mockModule" }],
    },
    { code: 'import * as bt from "bun:test";\nbt.mock.module("./x.ts", () => ({}));', filename: at, errors: [{ messageId: "testImport" }, { messageId: "mockModule" }] },
    { code: 'export const m = () => import("bun:test");', filename: at, errors: [{ messageId: "testImport" }] },
    { code: 'export * from "bun:test";', filename: at, errors: [{ messageId: "testImport" }] },
    { code: 'declare const mock: { module(p: string, f: () => object): void };\nmock["module"]("./x.ts", () => ({}));', filename: at, errors: [{ messageId: "mockModule" }] },
    { code: "export const x = 1;", filename: "contexts/pm/src/domain/notes/note_test.js", errors: [{ messageId: "testName" }] },
  ],
});
