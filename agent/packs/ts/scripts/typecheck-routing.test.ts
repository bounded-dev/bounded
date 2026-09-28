import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeTypecheck as routeWithZone, typecheckLines, mostUpstream, type FixOwner } from "./typecheck-routing.ts";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import { contractGlobs } from "../../../src/pack-contrib.ts";

// The architect's zone as a ts-composed project declares it (contracts and
// project config come from the ts pack's contrib data, not from the core).
const TS_ZONE = (() => {
  const dir = mkdtempSync(join(tmpdir(), "routing-zone-"));
  try {
    writeProjectPacks(dir, ["ts"]);
    return contractGlobs(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const routeTypecheck = (diagnostics: readonly string[]) => routeWithZone(diagnostics, TS_ZONE);

const err = (file: string, line: number, code: string, msg: string) =>
  `${file}(${line},5): error TS${code}: ${msg}`;

const TEST_ERR = err("tests/reading-list.test.ts", 12, "2532", "Object is possibly 'undefined'.");
const TEST_ERR_2 = err("tests/reading-list.test.ts", 18, "2532", "Object is possibly 'undefined'.");
const SRC_ERR = err("src/reading-list/reading-list.ts", 4, "2345", "Argument of type 'string'…");
const CONTRACT_ERR = err("src/reading-list/reading-list.contract.ts", 9, "2304", "Cannot find name 'Isbn'.");
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

  test("errors only in tests/** route to the test-writer (the Run 3 false green)", () => {
    const r = routeTypecheck([TEST_ERR, TEST_ERR_2, "Found 2 errors in the same file, starting at: tests/reading-list.test.ts:12"]);
    expect(r.errorCount).toBe(2);
    expect(r.route).toBe("test-writer");
    expect(r.owners).toEqual(["test-writer"]);
    expect(r.byOwner["test-writer"]).toEqual([TEST_ERR, TEST_ERR_2]);
  });

  test("errors only in src/** route to the builder", () => {
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
