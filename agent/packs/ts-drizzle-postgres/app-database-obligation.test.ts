// Issue #52 (ADR 2026-072): an app smoke test in a persisting project starts
// its own migrated Postgres through the generated support, so the project's
// own check needs nothing but a container engine. The obligation is static,
// modelled on ts-hexagonal's smokeTestProblem: a top-level `useAppDatabase()`
// imported from `./app-test-database.test-support.ts`, and every compose call
// inside a test, never while the file is collected.
import { describe, expect, test } from "vitest";
import { appDatabaseProblem } from "./scripts/app-database-obligation.ts";

const PATH = "apps/web/src/server/composition-root.test.ts";
const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const IMPORTS = [
  'import { expect, test } from "bun:test";',
  'import { useAppDatabase } from "./app-test-database.test-support.ts";',
  'import { composeWeb } from "./composition-root.ts";',
];
const TEST = [
  'test("the router answers", async () => {',
  "  const caller = composeWeb().createCaller({});",
  "  expect(await caller.notes.list()).toEqual([]);",
  "});",
];

describe("appDatabaseProblem", () => {
  test("a top-level useAppDatabase() from the generated support, with compose inside a test, has no problem", () => {
    expect(appDatabaseProblem(PATH, lines(...IMPORTS, "", "useAppDatabase();", "", ...TEST))).toBeUndefined();
    // Inside beforeAll or beforeEach, or a helper a test calls, compose runs at test time too.
    expect(appDatabaseProblem(PATH, lines(
      'import { beforeEach, expect, test } from "bun:test";',
      'import { useAppDatabase } from "./app-test-database.test-support.ts";',
      'import * as root from "./composition-root.ts";',
      "",
      "useAppDatabase();",
      "let app: ReturnType<typeof root.composeWeb>;",
      "beforeEach(() => { app = root.composeWeb(); });",
      "function fresh() { return root.composeWeb(); }",
      'test("x", () => { expect(fresh()).toBeDefined(); expect(app).toBeDefined(); });',
    ))).toBeUndefined();
  });

  test("no call is a problem", () => {
    const problem = appDatabaseProblem(PATH, lines(...IMPORTS, "", ...TEST));
    expect(problem).toContain(PATH);
    expect(problem).toContain("useAppDatabase");
  });

  test("a call inside dead code is a problem", () => {
    for (const dead of [
      ["if (false) {", "  useAppDatabase();", "}"],
      ["function never() {", "  useAppDatabase();", "}"],
      ["false && useAppDatabase();"],
      ['test("only here", () => { useAppDatabase(); });'],
    ]) {
      const problem = appDatabaseProblem(PATH, lines(...IMPORTS, "", ...dead, "", ...TEST));
      expect(problem, dead.join(" ")).toContain("useAppDatabase");
    }
  });

  test("an import from anywhere else, or a type-only import, is a problem", () => {
    for (const from of [
      'import { useAppDatabase } from "./database.ts";',
      'import { useAppDatabase } from "../app-test-database.test-support.ts";',
      'import type { useAppDatabase } from "./app-test-database.test-support.ts";',
      'import { type useAppDatabase } from "./app-test-database.test-support.ts";',
    ]) {
      const source = lines('import { expect, test } from "bun:test";', from, 'import { composeWeb } from "./composition-root.ts";', "", "useAppDatabase();", "", ...TEST);
      expect(appDatabaseProblem(PATH, source), from).toContain("app-test-database.test-support.ts");
    }
    // A local function of the same name is not the generated support.
    const local = lines('import { expect, test } from "bun:test";', 'import { composeWeb } from "./composition-root.ts";', "",
      "function useAppDatabase() {}", "useAppDatabase();", "", ...TEST);
    expect(appDatabaseProblem(PATH, local)).toContain("app-test-database.test-support.ts");
  });

  test("compose at module scope is a problem", () => {
    const top = appDatabaseProblem(PATH, lines(...IMPORTS, "", "useAppDatabase();", "const app = composeWeb();", "",
      'test("x", () => { expect(app).toBeDefined(); });'));
    expect(top).toContain("composeWeb");
    const inDescribe = appDatabaseProblem(PATH, lines(
      'import { describe, expect, test } from "bun:test";',
      'import { useAppDatabase } from "./app-test-database.test-support.ts";',
      'import { composeWeb } from "./composition-root.ts";',
      "",
      "useAppDatabase();",
      'describe("web", () => {',
      "  const app = composeWeb();",
      '  test("x", () => { expect(app).toBeDefined(); });',
      "});",
    ));
    expect(inDescribe).toContain("composeWeb");
  });
});
