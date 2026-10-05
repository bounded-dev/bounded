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

  // Final review of #52, major 3: the app was still composed before its
  // database existed. useAppDatabase() must come first, and no compose call
  // may be reachable while the file loads.
  test("useAppDatabase() must be the first statement after the imports", () => {
    const hookFirst = appDatabaseProblem(PATH, lines(...IMPORTS, 'import { beforeAll } from "bun:test";', "",
      "let app: unknown;", "beforeAll(() => { app = composeWeb(); });", "useAppDatabase();", "",
      'test("x", () => { expect(app).toBeDefined(); });'));
    expect(hookFirst).toMatch(/first statement/);
    const late = appDatabaseProblem(PATH, lines(...IMPORTS, "", 'const label = "web";', "useAppDatabase();", "", ...TEST));
    expect(late).toMatch(/first statement/);
  });

  test("a compose call reachable at load time is a problem, through helpers and describe.each", () => {
    const helper = appDatabaseProblem(PATH, lines(...IMPORTS, "", "useAppDatabase();",
      "function make() { return composeWeb(); }", "function twice() { return make(); }", "const app = twice();", "",
      'test("x", () => { expect(app).toBeDefined(); });'));
    expect(helper).toContain("composeWeb");
    const arrow = appDatabaseProblem(PATH, lines(...IMPORTS, "", "useAppDatabase();",
      "const make = () => composeWeb();", 'describe("web", () => { const app = make(); test("x", () => expect(app).toBeDefined()); });'));
    expect(arrow).toContain("composeWeb");
    const each = appDatabaseProblem(PATH, lines(...IMPORTS, 'import { describe } from "bun:test";', "", "useAppDatabase();",
      'describe.each([1, 2])("web %i", () => {', "  const app = composeWeb();", '  test("x", () => { expect(app).toBeDefined(); });', "});"));
    expect(each).toContain("composeWeb");
    const passed = appDatabaseProblem(PATH, lines(...IMPORTS, 'import { describe } from "bun:test";', "", "useAppDatabase();",
      "function body() { const app = composeWeb(); test(\"x\", () => { expect(app).toBeDefined(); }); }", 'describe("web", body);'));
    expect(passed).toContain("composeWeb");
    // A function declaration only tests call stays fine; an arrow bound to a
    // name is a value that can travel, so it is refused (re-review of #52).
    expect(appDatabaseProblem(PATH, lines(...IMPORTS, "", "useAppDatabase();", "function make() { return composeWeb(); }",
      'test("x", () => { expect(make()).toBeDefined(); });'))).toBeUndefined();
    expect(appDatabaseProblem(PATH, lines(...IMPORTS, "", "useAppDatabase();", "const make = () => composeWeb();",
      'test("x", () => { expect(make()).toBeDefined(); });'))).toContain("composeWeb");
  });

  // Re-review of #52: the check is structural. A smoke test imports only
  // bun:test, the generated support and the composition root (types from
  // anywhere), and a compose name appears only inside a test or a hook
  // callback, or a function declaration only those call directly.
  test("imports with side effects, or from anywhere else, are a problem", () => {
    for (const extra of [
      'import "./setup.ts";',
      'import { helper } from "./helpers.ts";',
      'import * as fs from "node:fs";',
    ]) {
      const problem = appDatabaseProblem(PATH, lines(...IMPORTS, extra, "", "useAppDatabase();", "", ...TEST));
      expect(problem, extra).toMatch(/imports only/);
    }
    const typesOnly = appDatabaseProblem(PATH, lines(...IMPORTS, 'import type { Note } from "@demo/notebook/domain";', "",
      "useAppDatabase();", "", "let last: Note | undefined;", ...TEST));
    expect(typesOnly).toBeUndefined();
    const dynamic = appDatabaseProblem(PATH, lines(...IMPORTS, "", "useAppDatabase();", 'await import("./setup.ts");', "", ...TEST));
    expect(dynamic).toMatch(/imports only/);
  });

  test("a compose name outside a test or a hook callback is a problem, however it is called", () => {
    for (const evasion of [
      "const app = composeWeb.call(undefined);",
      "const apps = [1].map(composeWeb);",
      "const app = Promise.resolve().then(() => composeWeb());",
      "const make = composeWeb;",
      "function make() { return composeWeb(); }\nconst apps = [1].map(make);",
      "function make() { return composeWeb(); }\nconst app = make.call(undefined);",
      'function make() { return composeWeb(); }\ntest("x", () => { expect([1].map(make)).toHaveLength(1); });',
    ]) {
      const problem = appDatabaseProblem(PATH, lines(...IMPORTS, "", "useAppDatabase();", evasion, "", ...TEST));
      expect(problem, evasion).toContain("composeWeb");
    }
    // Inside a hook registered after it, or nested inside a test, it is fine.
    expect(appDatabaseProblem(PATH, lines(...IMPORTS, 'import { beforeEach } from "bun:test";', "", "useAppDatabase();",
      "let app: ReturnType<typeof composeWeb>;", "beforeEach(() => { app = composeWeb(); });",
      'test("x", async () => { await Promise.resolve().then(() => composeWeb()); expect(app).toBeDefined(); });'))).toBeUndefined();
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
