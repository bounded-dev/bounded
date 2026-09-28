import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractGlobs } from "../../../src/pack-contrib.ts";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import { formatTypecheck, type TypecheckResult } from "./typecheck.ts";
import {
  formatScopedTypecheck,
  scopeGuardDetail,
  scopeTypecheck,
  scrubForeignPaths,
  visibilityOf,
} from "./typecheck-scope.ts";

// The diagnostics below are the shapes dogfood Run 15 actually produced. The
// TS2459 line is the leak verbatim: the builder read it out of its own
// typecheck, learned the test file's path, line, column and the symbol name
// `CalendarDate`, and added a re-export block to satisfy test source it may
// never read. Every assertion here exists to make that transcript impossible.

const SRC_ERR =
  "src/billing/billing.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.";
const SRC_ERR_2 =
  "src/billing/billing.ts(40,1): error TS2554: Expected 1 arguments, but got 0.";
const CONTRACT_ERR =
  "src/billing/billing.contract.ts(4,1): error TS2304: Cannot find name 'Money'.";
const SPEC_CONFIG_ERR =
  "tsconfig.json(3,5): error TS5023: Unknown compiler option 'strictNess'.";
const TEST_ERR =
  "tests/billing.test.ts(5,3): error TS2459: Module '\"./billing.js\"' declares 'CalendarDate' locally, but it is not exported.";
const TEST_ERR_2 = "tests/billing.test.ts(9,1): error TS2554: Expected 2 arguments, but got 1.";
const GLOBAL_ERR = "error TS18003: No inputs were found in config file 'tsconfig.json'.";

const result = (diagnostics: string[], ok = false): TypecheckResult => ({
  ok,
  errorCount: diagnostics.filter((l) => /error TS\d+/.test(l)).length,
  diagnostics,
});

/** The contract globs a ts-composed project resolves, as the gates pass it. */
const TS_ZONE = (() => {
  const dir = mkdtempSync(join(tmpdir(), "typecheck-scope-zone-"));
  try {
    writeProjectPacks(dir, ["ts"]);
    return contractGlobs(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

const MIXED = [SRC_ERR, SRC_ERR_2, CONTRACT_ERR, TEST_ERR, TEST_ERR_2];

describe("each role's view over one mixed diagnostic set", () => {
  test("the builder sees src/** and the shared interface; tests/** collapse to a count", () => {
    const s = scopeTypecheck(result(MIXED), "builder", TS_ZONE);
    expect(s.scoped).toBe(true);
    expect(s.shown).toBe(3);
    expect(s.hidden).toBe(2);
    expect(s.hiddenOwner).toBe("test-writer");
    expect(s.diagnostics).toEqual([SRC_ERR, SRC_ERR_2, CONTRACT_ERR]);
  });

  test("the test-writer sees tests/** and the contract; src/** collapse to the builder's", () => {
    const s = scopeTypecheck(result(MIXED), "test-writer", TS_ZONE);
    expect(s.shown).toBe(3);
    expect(s.hidden).toBe(2);
    expect(s.hiddenOwner).toBe("builder");
    expect(s.diagnostics).toEqual([CONTRACT_ERR, TEST_ERR, TEST_ERR_2]);
  });

  test("the reviewer owns nothing, so only the design it reviews stays visible", () => {
    const s = scopeTypecheck(result(MIXED), "reviewer", TS_ZONE);
    expect(s.diagnostics).toEqual([CONTRACT_ERR]);
    expect(s.hidden).toBe(4);
    expect(s.hiddenGroups).toEqual([
      { owner: "test-writer", count: 2 },
      { owner: "builder", count: 2 },
    ]);
  });

  test("config and spec-adjacent files are shared: every role sees them", () => {
    for (const role of ["builder", "test-writer", "reviewer"] as const) {
      expect(visibilityOf("tsconfig.json", role, TS_ZONE).visible).toBe(true);
      expect(visibilityOf("package.json", role, TS_ZONE).visible).toBe(true);
      expect(visibilityOf("vitest.config.ts", role, TS_ZONE).visible).toBe(true);
      expect(visibilityOf("spec.md", role).visible).toBe(true);
      expect(visibilityOf("src/billing/billing.contract.ts", role, TS_ZONE).visible).toBe(true);
    }
    const s = scopeTypecheck(result([SPEC_CONFIG_ERR, TEST_ERR]), "builder");
    expect(s.diagnostics).toEqual([SPEC_CONFIG_ERR]);
  });
});

describe("the worker-facing output", () => {
  test("mixed errors: own zone in full, the rest as count + owner", () => {
    const text = formatScopedTypecheck(scopeTypecheck(result(MIXED), "builder", TS_ZONE));
    expect(text).toBe(
      [
        "typecheck: 3 errors in your zone",
        "",
        SRC_ERR,
        SRC_ERR_2,
        CONTRACT_ERR,
        "",
        "typecheck: 2 further errors in another role's zone (test-writer's) — not yours to fix; they do not block you",
      ].join("\n"),
    );
  });

  test("clean HERE, red THERE never renders as OK", () => {
    const text = formatScopedTypecheck(scopeTypecheck(result([TEST_ERR, TEST_ERR_2]), "builder"));
    expect(text).toBe(
      [
        "typecheck: clean in your zone — no type errors you can fix",
        "",
        "typecheck: 2 further errors in another role's zone (test-writer's) — not yours to fix; they do not block you",
      ].join("\n"),
    );
    expect(text).not.toMatch(/\bOK\b/);
  });

  test("one foreign error reads in the singular", () => {
    const text = formatScopedTypecheck(scopeTypecheck(result([TEST_ERR]), "builder"));
    expect(text).toContain(
      "typecheck: 1 further error in another role's zone (test-writer's) — not yours to fix; it does not block you",
    );
  });

  test("a genuinely clean project still says OK", () => {
    const text = formatScopedTypecheck(scopeTypecheck(result([], true), "builder"));
    expect(text).toBe("typecheck: OK — no type errors");
  });

  test("tsc failing to run is never reported as clean", () => {
    const s = scopeTypecheck({ ok: false, errorCount: 0, diagnostics: ["Cannot find module 'typescript'"] }, "builder");
    expect(s.blocked).toBe(true);
    const text = formatScopedTypecheck(s);
    expect(text).toMatch(/could not run/);
    expect(text).not.toMatch(/clean in your zone|OK —/);
  });
});

describe("zero leak: nothing but a count and an owner crosses the boundary", () => {
  test("the Run 15 leak — path, line, column and symbol name are all absent", () => {
    const text = formatScopedTypecheck(scopeTypecheck(result(MIXED), "builder", TS_ZONE));
    for (const leak of [
      "CalendarDate",
      "tests/billing.test.ts",
      "billing.test",
      "TS2459",
      "(5,3)",
      "(9,1)",
      "declares",
      "Expected 2 arguments",
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  test("the test-writer cannot read the implementation's state either", () => {
    const text = formatScopedTypecheck(scopeTypecheck(result(MIXED), "test-writer", TS_ZONE));
    for (const leak of ["src/billing/billing.ts", "TS2322", "(12,7)", "not assignable"]) {
      expect(text).not.toContain(leak);
    }
  });

  test("a foreign path quoted INSIDE a visible diagnostic is scrubbed", () => {
    const quoting =
      "src/billing/billing.ts(3,1): error TS2307: Cannot find module '../tests/helpers/mint.ts' or its corresponding type declarations.";
    const text = formatScopedTypecheck(scopeTypecheck(result([quoting]), "builder"));
    expect(text).not.toContain("tests/helpers/mint.ts");
    expect(text).toContain("[another role's file]");
    expect(text).toContain("src/billing/billing.ts(3,1)");
  });

  test("scrubForeignPaths leaves the caller's own and shared paths alone", () => {
    const line = "note: src/a.ts, src/a.contract.ts, tsconfig.json, tests/a.test.ts";
    expect(scrubForeignPaths(line, "builder")).toBe(
      "note: src/a.ts, src/a.contract.ts, tsconfig.json, [another role's file]",
    );
  });

  test("indented continuation lines follow the diagnostic they belong to", () => {
    const s = scopeTypecheck(
      result([TEST_ERR, "  Types of property 'due' are incompatible.", SRC_ERR]),
      "builder",
    );
    expect(s.diagnostics).toEqual([SRC_ERR]);
    expect(formatScopedTypecheck(s)).not.toContain("due");
  });

  test("tsc related-information lines are classified by their OWN file", () => {
    const related = "tests/billing.test.ts(2,10): The expected type comes from property 'total'.";
    const s = scopeTypecheck(result([SRC_ERR, related]), "builder");
    expect(s.diagnostics).toEqual([SRC_ERR]);
    expect(s.shown).toBe(1);
  });

  test("the generated law suite is nobody's to write and still never reaches the builder", () => {
    const generated = "tests/generated/value-object-laws.test.ts(7,1): error TS2345: Argument of type 'Isbn'…";
    const s = scopeTypecheck(result([generated]), "builder");
    expect(s.diagnostics).toEqual([]);
    expect(s.hidden).toBe(1);
    expect(s.hiddenGroups).toEqual([{ count: 1 }]);
    const text = formatScopedTypecheck(s);
    expect(text).toContain(
      "typecheck: 1 further error outside your zone — not yours to fix; it does not block you",
    );
    expect(text).not.toContain("Isbn");
  });

  test("an error this parser cannot attribute is counted as hidden, never dropped", () => {
    // A redacted absolute path loses its (line,col), so the line no longer
    // parses as a diagnostic — but the error still happened.
    const s = scopeTypecheck(
      { ok: false, errorCount: 2, diagnostics: [SRC_ERR, "[path]: error TS6059: File is not under 'rootDir'."] },
      "builder",
    );
    expect(s.shown).toBe(1);
    expect(s.hidden).toBe(1);
    expect(formatScopedTypecheck(s)).not.toContain("rootDir");
  });
});

describe("the architect and unbound sessions are not scoped", () => {
  test("the architect keeps the whole project view, byte for byte", () => {
    const raw = result(MIXED);
    const s = scopeTypecheck(raw, "architect");
    expect(s.scoped).toBe(false);
    expect(s.diagnostics).toEqual(MIXED);
    expect(formatScopedTypecheck(s)).toBe(formatTypecheck(raw));
  });

  test("a session with no bound role is unscoped", () => {
    const raw = result(MIXED);
    const s = scopeTypecheck(raw, undefined);
    expect(s.scoped).toBe(false);
    expect(formatScopedTypecheck(s)).toBe(formatTypecheck(raw));
    expect(scopeGuardDetail(s)).toEqual({ scoped: false, shown: 5, hidden: 0, hiddenOwner: null });
  });
});

describe("the guard log records the split, never the content", () => {
  test("counts and the owning role", () => {
    const detail = scopeGuardDetail(scopeTypecheck(result(MIXED), "builder", TS_ZONE));
    expect(detail).toEqual({
      role: "builder",
      scoped: true,
      shown: 3,
      hidden: 2,
      hiddenOwner: "test-writer",
    });
    expect(JSON.stringify(detail)).not.toContain("CalendarDate");
  });

  test("nothing hidden ⇒ a null owner, not a missing field", () => {
    const detail = scopeGuardDetail(scopeTypecheck(result([SRC_ERR]), "builder"));
    expect(detail).toEqual({ role: "builder", scoped: true, shown: 1, hidden: 0, hiddenOwner: null });
  });

  test("a global config error is shown to the worker (it names no zone)", () => {
    const s = scopeTypecheck(result([GLOBAL_ERR]), "builder");
    expect(s.diagnostics).toEqual([GLOBAL_ERR]);
    expect(s.hidden).toBe(0);
  });
});
