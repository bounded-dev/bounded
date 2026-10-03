import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectOwnerOf,
  routeTypecheck as routeWithZone,
  typecheckLines,
  mostUpstream,
  type FixOwner,
} from "./typecheck-routing.ts";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import { pathLayoutFor } from "../../../src/pack-contrib.ts";

// The layout a hexagonal ts project composes (source roots, test suffixes,
// contract and generated globs come from the packs' contrib data, not from
// the core).
const LAYOUT = pathLayoutFor(["ts", "ts-hexagonal"]);
const routeTypecheck = (diagnostics: readonly string[]) => routeWithZone(diagnostics, LAYOUT);

const err = (file: string, line: number, code: string, msg: string) =>
  `${file}(${line},5): error TS${code}: ${msg}`;

const DIR = "contexts/library/src/domain/reading-list";
const TEST_ERR = err(`${DIR}/reading-list.test.ts`, 12, "2532", "Object is possibly 'undefined'.");
const TEST_ERR_2 = err(`${DIR}/reading-list.test.ts`, 18, "2532", "Object is possibly 'undefined'.");
const SRC_ERR = err(`${DIR}/reading-list.ts`, 4, "2345", "Argument of type 'string'…");
const CONTRACT_ERR = err(`${DIR}/reading-list.contract.ts`, 9, "2304", "Cannot find name 'Isbn'.");
const CONFIG_ERR = "error TS18003: No inputs were found in config file 'tsconfig.json'.";

describe("routeTypecheck", () => {
  test("no diagnostics → no errors, no route", () => {
    const r = routeTypecheck([]);
    expect(r.errorCount).toBe(0);
    expect(r.route).toBeUndefined();
    expect(r.owners).toEqual([]);
  });

  test("non-error lines (summaries, blank noise) are not counted", () => {
    const r = routeTypecheck(["Found 0 errors.", "tests/x.test.ts(1,1): note something"]);
    expect(r.errorCount).toBe(0);
    expect(r.route).toBeUndefined();
  });

  test("errors only in test files route to the test-writer (the Run 3 false green)", () => {
    const r = routeTypecheck([TEST_ERR, TEST_ERR_2, `Found 2 errors in the same file, starting at: ${DIR}/reading-list.test.ts:12`]);
    expect(r.errorCount).toBe(2);
    expect(r.route).toBe("test-writer");
    expect(r.owners).toEqual(["test-writer"]);
    expect(r.byOwner["test-writer"]).toEqual([TEST_ERR, TEST_ERR_2]);
  });

  test("errors only in implementation files route to the builder", () => {
    const r = routeTypecheck([SRC_ERR]);
    expect(r.route).toBe("builder");
    expect(r.byOwner["builder"]).toEqual([SRC_ERR]);
  });

  test("contract errors route to the architect", () => {
    const r = routeTypecheck([CONTRACT_ERR]);
    expect(r.route).toBe("architect");
  });

  test("errors nobody in the pipeline may write route to the orchestrator", () => {
    const r = routeTypecheck([CONFIG_ERR]);
    expect(r.errorCount).toBe(1);
    expect(r.route).toBe("orchestrator");
    expect(r.byOwner["orchestrator"]).toEqual([CONFIG_ERR]);
  });

  test("mixed ownership routes to the furthest-upstream owner and keeps every group", () => {
    const r = routeTypecheck([SRC_ERR, TEST_ERR, CONTRACT_ERR]);
    expect(r.errorCount).toBe(3);
    expect(r.route).toBe("architect");
    expect(r.owners).toEqual(["architect", "test-writer", "builder"]);
    expect(r.byOwner["architect"]).toEqual([CONTRACT_ERR]);
    expect(r.byOwner["test-writer"]).toEqual([TEST_ERR]);
    expect(r.byOwner["builder"]).toEqual([SRC_ERR]);
  });

  test("an unfixable-by-anyone error outranks all worker errors", () => {
    const r = routeTypecheck([SRC_ERR, CONFIG_ERR, CONTRACT_ERR]);
    expect(r.route).toBe("orchestrator");
    expect(r.owners).toEqual(["orchestrator", "architect", "builder"]);
  });

  test("continuation lines stay attached to the diagnostic above them", () => {
    const r = routeTypecheck([TEST_ERR, "  Type 'string' is not assignable to type 'Isbn'.", SRC_ERR]);
    expect(r.errorCount).toBe(2);
    expect(r.byOwner["test-writer"]).toEqual([TEST_ERR, "  Type 'string' is not assignable to type 'Isbn'."]);
    expect(r.byOwner["builder"]).toEqual([SRC_ERR]);
  });
});

describe("mostUpstream", () => {
  test("orders orchestrator → architect → test-writer → builder", () => {
    const all: FixOwner[] = ["builder", "test-writer", "architect", "orchestrator"];
    expect(mostUpstream(all)).toBe("orchestrator");
    expect(mostUpstream(["builder", "test-writer"])).toBe("test-writer");
    expect(mostUpstream(["builder"])).toBe("builder");
    expect(mostUpstream([])).toBeUndefined();
  });
});

describe("typecheckLines", () => {
  test("names the count and every diagnostic grouped by owner", () => {
    const lines = typecheckLines(routeTypecheck([TEST_ERR, SRC_ERR]));
    expect(lines[0]).toBe("  typecheck: 2 type errors");
    expect(lines.join("\n")).toContain("  test-writer (1):");
    expect(lines.join("\n")).toContain(`    ${TEST_ERR}`);
    expect(lines.join("\n")).toContain("  builder (1):");
  });

  test("singular wording for one error", () => {
    expect(typecheckLines(routeTypecheck([SRC_ERR]))[0]).toBe("  typecheck: 1 type error");
  });

  test("clean typecheck produces no lines", () => {
    expect(typecheckLines(routeTypecheck([]))).toEqual([]);
  });
});

// --- suffix ownership (ADR 2026-057) through the path policy ------------------

describe("routing a monorepo's diagnostics by file suffix", () => {
  const dir = mkdtempSync(join(tmpdir(), "routing-suffix-"));
  writeProjectPacks(dir, ["ts", "ts-hexagonal"]);
  const ownerOf = projectOwnerOf(dir);
  rmSync(dir, { recursive: true, force: true });

  test("contract → architect; test-side → test-writer; implementation → builder; generated and outside → nobody", () => {
    const cases: [string, string | null][] = [
      ["contexts/pm/src/application/notes/create-note/create-note.contract.ts", "architect"],
      ["contexts/pm/src/application/notes/create-note/create-note.test.ts", "test-writer"],
      ["contexts/pm/src/application/notes/create-note/create-note.store.test-support.ts", "test-writer"],
      ["apps/web/src/client/app.test.tsx", "test-writer"],
      ["contexts/pm/src/application/notes/create-note/create-note.handler.ts", "builder"],
      ["apps/web/src/server/composition-root.ts", "builder"],
      ["contexts/pm/src/domain/notes/note-text.laws.test.ts", null],
      ["contexts/pm/src/application/notes/create-note/create-note.command.ts", null],
      ["architecture.test.ts", null],
      ["tsconfig.json", null],
      ["contexts/pm/package.json", null],
      ["/abs/contexts/pm/src/x.ts", null],
      ["contexts/pm/src/../../x.ts", null],
    ];
    for (const [path, owner] of cases) expect(ownerOf(path), path).toBe(owner);
  });

  test("with the app packs composed, every app's composition root is generated: nobody's (ADR 2026-066)", () => {
    const apps = mkdtempSync(join(tmpdir(), "routing-apps-"));
    writeProjectPacks(apps, ["ts", "ts-hexagonal", "ts-trpc", "ts-mcp", "ts-lambda", "ts-web", "ts-desktop"]);
    const appOwnerOf = projectOwnerOf(apps);
    rmSync(apps, { recursive: true, force: true });
    for (const root of ["apps/web/src/server", "apps/desktop/src/main", "apps/mcp/src", "apps/lambdas/src"]) {
      expect(appOwnerOf(`${root}/composition-root.ts`), root).toBe(null);
      expect(appOwnerOf(`${root}/composition-root.test.ts`), root).toBe("test-writer");
    }
    expect(appOwnerOf("apps/web/src/server/main.ts")).toBe("builder");
  });

  test("a root matches in any case; a test suffix in another case is nobody's (ambiguous to case-sensitive tools)", () => {
    expect(ownerOf("Contexts/pm/src/x.ts")).toBe("builder");
    expect(ownerOf("contexts/pm/src/X.TEST.TS")).toBe(null);
  });

  test("a test file's type error bounces to the test-writer, an implementation's to the builder, upstream first", () => {
    const routing = routeWithZone([
      "contexts/pm/src/application/notes/create-note/create-note.handler.ts(3,1): error TS2322: bad",
      "contexts/pm/src/application/notes/create-note/create-note.test.ts(9,5): error TS2345: bad",
      "  continuation of the test error",
      "contexts/pm/src/domain/notes/note-text.laws.test.ts(1,1): error TS2304: bad",
    ], ownerOf);
    expect(routing.owners).toEqual(["orchestrator", "test-writer", "builder"]);
    expect(routing.route).toBe("orchestrator");
    expect(routing.byOwner["test-writer"]).toEqual([
      "contexts/pm/src/application/notes/create-note/create-note.test.ts(9,5): error TS2345: bad",
      "  continuation of the test error",
    ]);
  });

  test("projectOwnerOf: nobody owns source where no source roots are composed, nor when the composition is unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-owner-"));
    try {
      writeProjectPacks(dir, ["ts"]);
      expect(projectOwnerOf(dir)("src/a.ts")).toBe(null);
      expect(projectOwnerOf(dir)("contexts/pm/src/a.ts")).toBe(null);
      writeProjectPacks(dir, ["ts", "ts-hexagonal"]);
      expect(projectOwnerOf(dir)("contexts/pm/src/a.ts")).toBe("builder");
      rmSync(join(dir, ".bounded"), { recursive: true, force: true });
      expect(projectOwnerOf(dir)("contexts/pm/src/a.ts")).toBe(null);
      expect(projectOwnerOf(dir)("contexts/pm/src/a.test.ts")).toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
