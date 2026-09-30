import { writeProjectPacks } from "../../../src/project-composition.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { classifyGreen, redBindingFor, redPassStandsForCurrentContracts } from "./green-gate.ts";
import { testsTreeHash } from "./red-gate.ts";
import type { RunTestsResult } from "./run-tests.ts";
import type { TypecheckResult } from "./typecheck.ts";
import { readGuardLog } from "../../../src/guard-log.ts";
import { pathLayoutFor } from "../../../src/pack-contrib.ts";

// The layout a hexagonal ts project composes (pack contrib data): who owns
// each file a diagnostic names.
const TS_ZONE = pathLayoutFor(["ts", "ts-hexagonal"]);

/** The gate's own entry. The green gate also runs the src escape-hatch lint,
 *  which logs its own line, so "the last entry" is no longer the gate's. */
function greenEntry(dir: string) {
  return readGuardLog(dir).find((e) => e.guard === "green-gate");
}

function vitestJson(cases: { name: string; status: string; message?: string }[]): string {
  return JSON.stringify({
    testResults: [
      {
        status: cases.some((c) => c.status === "failed") ? "failed" : "passed",
        assertionResults: cases.map((c) => ({
          fullName: c.name,
          title: c.name,
          ancestorTitles: [],
          status: c.status,
          failureMessages: c.message ? [c.message] : [],
        })),
      },
    ],
  });
}

function run(partial: Partial<RunTestsResult>): RunTestsResult {
  return { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, results: [], ...partial };
}

/** A clean typecheck — the precondition every pre-#7 green implicitly assumed. */
const TYPE_CLEAN: TypecheckResult = { ok: true, errorCount: 0, diagnostics: [] };

function tsc(...diagnostics: string[]): TypecheckResult {
  return { ok: false, errorCount: diagnostics.length, diagnostics };
}

const RL = "contexts/library/src/domain/reading-list";
const TEST_TYPE_ERR = `${RL}/reading-list.test.ts(12,5): error TS2532: Object is possibly 'undefined'.`;
const SRC_TYPE_ERR = `${RL}/reading-list.ts(4,3): error TS2345: Argument of type 'string'…`;
const CONTRACT_TYPE_ERR = `${RL}/reading-list.contract.ts(9,1): error TS2304: Cannot find name 'Isbn'.`;

// --- pure core: classifyGreen -------------------------------------------------

describe("classifyGreen", () => {
  test("all tests pass → exit 0", () => {
    const r = classifyGreen(
      run({ ok: true, total: 2, passed: 2, results: [{ name: "a", status: "passed" }, { name: "b", status: "passed" }] }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(0);
    expect(r.verdict).toBe("pass");
    expect(r.lines[0]).toMatch(/green-gate: OK — 2 passed, 2 total/);
  });

  test("any failure → exit 1, naming each failing test", () => {
    const r = classifyGreen(
      run({
        total: 2,
        passed: 1,
        failed: 1,
        results: [
          { name: "adds", status: "passed" },
          { name: "subtracts", status: "failed", message: "AssertionError: expected 1 to be 2" },
        ],
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/1 failing test of 2/);
    expect(r.lines.join("\n")).toContain("failed: subtracts");
  });

  test("blocked suite → exit 1", () => {
    const r = classifyGreen(run({ blocked: "Error: Cannot find module [path]" }), TYPE_CLEAN);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/suite did not run/);
  });

  test("no tests ran → exit 1", () => {
    const r = classifyGreen(run({ total: 0 }), TYPE_CLEAN);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/no tests ran/);
  });

  // dogfood Run 29 (opus): 224/224 assertions passed while a throw inside a
  // React event handler surfaced as vitest's UNHANDLED error. Every assertion
  // "passed", so a pass/fail tally called it green. It is not green, and the
  // block routes to whoever owns the tests.
  test("an unhandled error → exit 1, even with every assertion passing", () => {
    const r = classifyGreen(
      run({
        ok: false,
        total: 224,
        passed: 224,
        failed: 0,
        results: Array.from({ length: 224 }, (_, i) => ({ name: `t${i}`, status: "passed" as const })),
        unhandled: "the suite raised an unhandled error — a throw outside any assertion.",
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(1);
    expect(r.verdict).toBe("block");
    expect(r.lines[0]).toMatch(/unhandled error/i);
    expect(r.lines).toContain("green-gate: route → test-writer");
    expect(r.detail).toMatchObject({ reason: "unhandled", route: "test-writer" });
  });
});

// --- #7: green requires a type-clean project, not just a passing suite --------
// Dogfood Run 3 shipped "GREEN (22/22)" with two tsc errors in the test file.
// Green means both, and the gate must say which role can fix what it found.

const passing = (n: number): Partial<RunTestsResult> => ({
  ok: true,
  total: n,
  passed: n,
  results: Array.from({ length: n }, (_, i) => ({ name: `t${i}`, status: "passed" as const })),
});

describe("classifyGreen + typecheck (#7)", () => {
  test("passing suite with type errors is NOT green", () => {
    const r = classifyGreen(run(passing(22)), tsc(TEST_TYPE_ERR), [], [], [], TS_ZONE);
    expect(r.code).toBe(1);
    expect(r.verdict).toBe("block");
    expect(r.lines[0]).toMatch(/green-gate: FAIL — 1 type error/);
    expect(r.lines[0]).toMatch(/suite passes/);
  });

  test("type errors confined to test files route to the test-writer", () => {
    const r = classifyGreen(run(passing(22)), tsc(TEST_TYPE_ERR, TEST_TYPE_ERR), [], [], [], TS_ZONE);
    expect(r.lines).toContain("green-gate: route → test-writer");
    expect(r.lines.join("\n")).toContain("  test-writer (2):");
    expect(r.lines.join("\n")).toContain(TEST_TYPE_ERR);
    expect(r.detail).toMatchObject({ route: "test-writer", typeErrors: 2 });
  });

  test("type errors in implementation files route to the builder", () => {
    const r = classifyGreen(run(passing(3)), tsc(SRC_TYPE_ERR), [], [], [], TS_ZONE);
    expect(r.lines).toContain("green-gate: route → builder");
  });

  test("failing tests plus upstream type errors route upstream, and report both", () => {
    const r = classifyGreen(
      run({
        total: 2,
        passed: 1,
        failed: 1,
        results: [
          { name: "adds", status: "passed" },
          { name: "subtracts", status: "failed", message: "AssertionError: expected 1 to be 2" },
        ],
      }),
      tsc(CONTRACT_TYPE_ERR),
      [],
      [],
      [],
      TS_ZONE,
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/1 failing test of 2/);
    expect(r.lines.join("\n")).toContain("failed: subtracts");
    expect(r.lines.join("\n")).toContain("  typecheck: 1 type error");
    expect(r.lines).toContain("green-gate: route → architect");
  });

  test("failing tests with a type-clean project still route to the builder", () => {
    const r = classifyGreen(
      run({ total: 1, failed: 1, results: [{ name: "x", status: "failed", message: "AssertionError" }] }),
      TYPE_CLEAN,
    );
    expect(r.lines).toContain("green-gate: route → builder");
  });

  test("a blocked suite routes to the test-writer (dispute protocol BLOCKED)", () => {
    const r = classifyGreen(run({ blocked: "Error: Cannot find module [path]" }), TYPE_CLEAN);
    expect(r.lines).toContain("green-gate: route → test-writer");
  });

  test("green states that the project is type-clean, so the claim is auditable", () => {
    const r = classifyGreen(run(passing(22)), TYPE_CLEAN);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/22 passed, 22 total, typecheck clean/);
    expect(r.detail).toMatchObject({ typeErrors: 0 });
  });
});

// --- r16: a surviving red-phase skeleton is not green -------------------------
// billing.ts stayed a throwing skeleton and green passed 179/179 TWICE, because
// no test imported its exports so nothing ever executed the throw. Only deliver
// caught it, at the very end. The scan is deliver's predicate, moved upstream.

describe("classifyGreen: a surviving skeleton import (r16)", () => {
  const SKELETON = [{ file: "src/billing/billing.ts", names: ["NotImplementedError"] }];

  test("a fully passing, type-clean suite still BLOCKS when a skeleton import survives", () => {
    const r = classifyGreen(run(passing(179)), TYPE_CLEAN, [], [], SKELETON);
    expect(r.code).toBe(1);
    expect(r.verdict).toBe("block");
    expect(r.lines[0]).toMatch(/unimplemented skeleton reached green/);
    expect(r.lines[0]).toMatch(/179\/179/);
    expect(r.lines.join("\n")).toContain("skeleton: src/billing/billing.ts imports NotImplementedError");
    expect(r.lines.at(-1)).toBe("green-gate: route → builder");
    expect(r.detail).toMatchObject({ route: "builder", skeletonImports: ["src/billing/billing.ts"] });
  });

  test("no skeleton import → still green (the scan does not fire on an implemented tree)", () => {
    const r = classifyGreen(run(passing(179)), TYPE_CLEAN, [], [], []);
    expect(r.code).toBe(0);
    expect(r.verdict).toBe("pass");
  });

  test("a failing suite dominates the headline, but the skeleton is still named and still bounces", () => {
    const r = classifyGreen(
      run({ total: 2, passed: 1, failed: 1, results: [{ name: "a", status: "passed" }, { name: "b", status: "failed", message: "AssertionError" }] }),
      TYPE_CLEAN,
      [],
      [],
      SKELETON,
    );
    expect(r.lines[0]).toMatch(/1 failing test of 2/);
    expect(r.summary).toContain("unimplemented skeleton");
    expect(r.lines.join("\n")).toContain("skeleton: src/billing/billing.ts imports NotImplementedError");
    expect(r.detail).toMatchObject({ route: "builder", skeletonImports: ["src/billing/billing.ts"] });
  });
});

// --- CLI (fixture-repo) -------------------------------------------------------

const SCRIPT = join(import.meta.dirname, "green-gate.ts");
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fixtureRepo(prefix: string, runJson: string, tscOutput = ""): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeProjectPacks(dir, ["ts", "ts-hexagonal"]);
  tmpDirs.push(dir);
  writeFileSync(join(dir, "run.json"), runJson);
  writeFileSync(join(dir, "tsc.txt"), tscOutput);
  // Green refuses without a red pass since the last freeze (Run 10). Seed the
  // normal history: frozen, then a valid red.
  mkdirSync(join(dir, ".bounded"), { recursive: true });
  seedRedPass(dir);
  return dir;
}

/** The normal history green expects: contracts frozen, then a red pass — and
 *  that red carries the hash of the tests tree it ran against, because green is
 *  bound to BOTH (the contracts it was frozen for and the tests it proved). */
function seedRedPass(dir: string, testsHash: string = testsTreeHash(dir)): void {
  writeFileSync(
    join(dir, ".bounded", "guard-log.jsonl"),
    [
      JSON.stringify({ ts: "2026-09-04T00:00:00.000Z", guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (1 contract file)" }),
      JSON.stringify({
        ts: "2026-09-04T00:01:00.000Z",
        guard: "red-gate",
        verdict: "pass",
        summary: "RED OK (5 NotImplemented failures, 0 passed)",
        detail: { shadow: ".bounded/shadow-red", testsTreeHash: testsHash },
      }),
    ].join("\n") + "\n",
  );
}

function runGate(dir: string, typeErrors = false) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      BOUNDED_GATE_TEST_CMD: "cat",
      BOUNDED_GATE_TEST_ARGS: JSON.stringify(["run.json"]),
      // tsc stand-in: replay a captured diagnostics file with tsc's exit code.
      BOUNDED_GATE_TSC_CMD: "sh",
      BOUNDED_GATE_TSC_ARGS: JSON.stringify(["-c", `cat tsc.txt; exit ${typeErrors ? 2 : 0}`]),
    },
  });
}

describe("green-gate CLI (fixture repos)", () => {
  test("green target → exit 0 and a logged pass", () => {
    const dir = fixtureRepo(
      "green-ok-",
      vitestJson([{ name: "create order", status: "passed" }, { name: "cancel order", status: "passed" }]),
    );
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/green-gate: OK — 2 passed, 2 total/);
    expect(greenEntry(dir)).toMatchObject({ guard: "green-gate", verdict: "pass" });
  });

  test("failing target → exit 1, names the failure, logs a block", () => {
    const dir = fixtureRepo(
      "green-fail-",
      vitestJson([
        { name: "create order", status: "passed" },
        { name: "cancel order", status: "failed", message: "AssertionError: expected 'open' to be 'cancelled'" },
      ]),
    );
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/1 failing test of 2/);
    expect(r.stdout).toContain("failed: cancel order");
    expect(greenEntry(dir)).toMatchObject({ guard: "green-gate", verdict: "block" });
  });

  test("passing suite + test-file type errors → exit 1, routed, logged as a block (#7)", () => {
    const dir = fixtureRepo(
      "green-falsegreen-",
      vitestJson([{ name: "adds a book", status: "passed" }, { name: "lists books", status: "passed" }]),
      `${TEST_TYPE_ERR}\nFound 1 error in ${RL}/reading-list.test.ts:12\n`,
    );
    const r = runGate(dir, true);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/green-gate: FAIL — 1 type error/);
    expect(r.stdout).toContain("green-gate: route → test-writer");
    expect(greenEntry(dir)).toMatchObject({
      guard: "green-gate",
      verdict: "block",
      detail: { route: "test-writer", typeErrors: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// The escape hatch: a test that keeps failing may itself be the defect
// ---------------------------------------------------------------------------

// Dogfood Run 6 deadlocked here. The last failing test read `invoices[1]` where
// it needed `invoices[2]` — it had copied the index from a sibling test with no
// renewal step, so the array was one shorter. The implementation was correct.
//
// Every component behaved exactly as specified, and the loop still could not
// escape: the green gate routed by its rule (a failing test means the code is
// wrong), the architect obeyed the route as the skill instructs, and the
// builder cannot fix a test it is blind to. It respawned the builder and hit
// the identical failure.
//
// The rule is right in the common case and unrecoverable in this one, and
// nothing could tell the two apart. So the FIRST block routes to the builder as
// before, and a REPEAT of the same failing set routes to the test-writer. Same
// reasoning as the run_tests non-convergence nudge: repetition is the evidence,
// and no model judgement is involved.

import { routeAfterRepeat } from "./green-gate.ts";

describe("repeated identical failures reroute to the test-writer", () => {
  const A = ["changePlan proration after renewal"];
  const B = ["cancel is idempotent"];

  test("a first failure routes to the builder", () => {
    expect(routeAfterRepeat(A, [])).toBe("builder");
  });

  test("a different failure than last time still routes to the builder", () => {
    expect(routeAfterRepeat(A, [B])).toBe("builder");
  });

  test("the same failing set twice routes to the test-writer", () => {
    expect(routeAfterRepeat(A, [A])).toBe("test-writer");
  });

  test("order within the failing set does not matter", () => {
    expect(routeAfterRepeat(["a", "b"], [["b", "a"]])).toBe("test-writer");
  });

  test("an intervening different failure resets the evidence", () => {
    // Progress happened, so the builder is not stuck against the same wall.
    expect(routeAfterRepeat(A, [A, B])).toBe("builder");
  });

  test("an empty failing set never reroutes", () => {
    expect(routeAfterRepeat([], [[]])).toBe("builder");
  });
});

// --- Escape hatches are a gate failure, not a style note --------------------------
//
// Dogfood Run 7: tsc correctly rejected `findInvoiceByOperationId(...)` as
// `Invoice | undefined` and the builder wrote `!` to silence it. The suite was
// 32/32 and the project was type-clean, so the green gate passed and a runtime
// contract violation shipped. A passing suite reached by switching the type
// checker off is the same class of false green as a passing suite that does not
// compile.

// A domain folder under a source root of the composed hexagonal layout: where
// the escape-hatch lint looks, and where a concept file has a role.
const SRC_ROOT = join("contexts", "billing", "src", "domain", "invoices");

describe("green-gate CLI: source escape hatches", () => {
  const allPassing = vitestJson([{ name: "renews", status: "passed" }]);

  test("a non-null assertion in a source root blocks the green and routes to the builder", () => {
    const dir = fixtureRepo("green-hatch-", allPassing);
    mkdirSync(join(dir, SRC_ROOT), { recursive: true });
    writeFileSync(
      join(dir, SRC_ROOT, "invoice.ts"),
      [
        "interface Invoice { id: string }",
        "function find(xs: Invoice[], id: string): Invoice | undefined { return xs.find(i => i.id === id); }",
        "export function renew(xs: Invoice[], id: string): Invoice { return find(xs, id)!; }",
      ].join("\n") + "\n",
    );
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/the type checker was switched off to get there/);
    expect(r.stdout).toContain("no-non-null-assertion");
    expect(r.stdout).toContain("green-gate: route → builder");
    expect(greenEntry(dir)).toMatchObject({ guard: "green-gate", verdict: "block", detail: { escapeHatches: 1 } });
  });

  test("a clean source root still passes", () => {
    const dir = fixtureRepo("green-clean-", allPassing);
    mkdirSync(join(dir, SRC_ROOT), { recursive: true });
    writeFileSync(join(dir, SRC_ROOT, "invoice.ts"), "export const rate = { pct: 5 } as const;\n");
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(greenEntry(dir)).toMatchObject({ guard: "green-gate", verdict: "pass" });
  });
});

// The contract must bind at green, not just at scaffold. Run 8 shipped
// Money.signed and nine undeclared re-exports through a green gate that only
// asked about tests and types.

describe("green-gate CLI: surface violations", () => {
  const allPassing = vitestJson([{ name: "renews", status: "passed" }]);

  test("an undeclared public member blocks the green and routes to the builder", () => {
    const dir = fixtureRepo("green-surface-", allPassing);
    mkdirSync(join(dir, "src", "shared"), { recursive: true });
    writeFileSync(
      join(dir, "src", "shared", "money.contract.ts"),
      [
        "export declare class Money {",
        '  private readonly __brand: "Money";',
        "  private constructor();",
        "  readonly minorUnits: number;",
        "  static parse(raw: unknown): Money | undefined;",
        "}",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(dir, "src", "shared", "money.ts"),
      [
        'export type * from "./money.contract.js";',
        "// zod-backed-parse asks for schema delegation; the gate seams fake tsc,",
        "// so a structural stand-in with the same safeParse shape keeps the",
        "// fixture dependency-free.",
        "const schema = {",
        "  safeParse: (raw: unknown) =>",
        '    typeof raw === "number"',
        "      ? { success: true as const, data: raw }",
        "      : { success: false as const, data: 0 },",
        "};",
        "export class Money {",
        '  declare private readonly __brand: "Money";',
        "  private constructor(readonly minorUnits: number) {}",
        "  static parse(raw: unknown): Money | undefined {",
        "    const r = schema.safeParse(raw);",
        "    return r.success ? new Money(r.data) : undefined;",
        "  }",
        "  // Undeclared public surface — the Run 8 case.",
        "  static signed(n: number): number { return n; }",
        "}",
      ].join("\n") + "\n",
    );
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/public surface does not match the contract/);
    expect(r.stdout).toContain("Money.signed");
    expect(r.stdout).toContain("green-gate: route → builder");
    expect(greenEntry(dir)).toMatchObject({ guard: "green-gate", verdict: "block", detail: { surfaceViolations: 1 } });
  });

  test("a conforming surface still passes", () => {
    const dir = fixtureRepo("green-surface-ok-", allPassing);
    mkdirSync(join(dir, "src", "shared"), { recursive: true });
    writeFileSync(
      join(dir, "src", "shared", "money.contract.ts"),
      [
        "export declare class Money {",
        '  private readonly __brand: "Money";',
        "  private constructor();",
        "  readonly minorUnits: number;",
        "  static parse(raw: unknown): Money | undefined;",
        "}",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(dir, "src", "shared", "money.ts"),
      [
        'export type * from "./money.contract.js";',
        "// zod-backed-parse asks for schema delegation; the gate seams fake tsc,",
        "// so a structural stand-in with the same safeParse shape keeps the",
        "// fixture dependency-free.",
        "const schema = {",
        "  safeParse: (raw: unknown) =>",
        '    typeof raw === "number"',
        "      ? { success: true as const, data: raw }",
        "      : { success: false as const, data: 0 },",
        "};",
        "export class Money {",
        '  declare private readonly __brand: "Money";',
        "  private constructor(readonly minorUnits: number) {}",
        "  static parse(raw: unknown): Money | undefined {",
        "    const r = schema.safeParse(raw);",
        "    return r.success ? new Money(r.data) : undefined;",
        "  }",
        "}",
      ].join("\n") + "\n",
    );
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(greenEntry(dir)).toMatchObject({ guard: "green-gate", verdict: "pass" });
  });
});

// r16: billing.ts stayed a throwing skeleton, green passed 179/179 TWICE (no
// test imported its exports, so nothing ran the throw), and only deliver caught
// it — minutes later, at the end. The scan is deliver's own, moved upstream so
// a green that is green only because an unimplemented throw never ran is caught
// the moment the suite passes, named, and bounced to the builder.

describe("green-gate CLI: a surviving red-phase skeleton (r16)", () => {
  const allPassing = vitestJson([
    { name: "charges a card", status: "passed" },
    { name: "refunds a card", status: "passed" },
  ]);
  const ERRORS_TS = [
    "export class NotImplementedError extends Error {",
    "  constructor(what: string) {",
    "    super(`not implemented: ${what}`);",
    '    this.name = "NotImplementedError";',
    "  }",
    "}",
  ].join("\n") + "\n";

  test("a fully passing suite still blocks when a src skeleton import survives, naming the file", () => {
    const dir = fixtureRepo("green-skeleton-", allPassing);
    mkdirSync(join(dir, "src", "shared"), { recursive: true });
    mkdirSync(join(dir, "src", "billing"), { recursive: true });
    writeFileSync(join(dir, "src", "shared", "errors.ts"), ERRORS_TS);
    writeFileSync(
      join(dir, "src", "billing", "billing.ts"),
      [
        'import { NotImplementedError } from "../shared/errors.js";',
        "export function chargeCard(id: string): never {",
        '  throw new NotImplementedError("chargeCard");',
        "}",
      ].join("\n") + "\n",
    );
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/unimplemented skeleton reached green/);
    expect(r.stdout).toContain("skeleton: src/billing/billing.ts imports NotImplementedError");
    expect(r.stdout).toContain("green-gate: route → builder");
    expect(greenEntry(dir)).toMatchObject({
      guard: "green-gate",
      verdict: "block",
      detail: { route: "builder", skeletonImports: ["src/billing/billing.ts"] },
    });
  });

  test("an implemented src/ (no errors-module import) still passes", () => {
    const dir = fixtureRepo("green-skeleton-ok-", allPassing);
    mkdirSync(join(dir, "src", "billing"), { recursive: true });
    writeFileSync(
      join(dir, "src", "billing", "billing.ts"),
      "export function chargeCard(id: string): string { return id; }\n",
    );
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(greenEntry(dir)).toMatchObject({ guard: "green-gate", verdict: "pass" });
  });
});

// Run 10 (kimi): contract re-frozen mid-loop, red never re-established, green
// ran anyway and passed 148/148 — with the sign-off admitting the red could
// not pass. The ordering was prose; now it refuses.

describe("green requires a red for the CURRENT contracts", () => {
  test("no red at all → green refuses before running anything", () => {
    const dir = fixtureRepo("green-nored-", vitestJson([{ name: "ok", status: "passed" }]));
    writeFileSync(join(dir, ".bounded", "guard-log.jsonl"), "");
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/no red-gate pass since the contracts were last frozen/);
    expect(r.stdout).toContain("green-gate: route → architect");
  });

  test("a red pass BEFORE the latest freeze is stale — refused", () => {
    const dir = fixtureRepo("green-stalered-", vitestJson([{ name: "ok", status: "passed" }]));
    writeFileSync(
      join(dir, ".bounded", "guard-log.jsonl"),
      [
        JSON.stringify({ ts: "2026-09-04T00:00:00.000Z", guard: "red-gate", verdict: "pass", summary: "RED OK (5 NotImplemented failures, 0 passed)" }),
        JSON.stringify({ ts: "2026-09-04T00:01:00.000Z", guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (2 contract files)" }),
      ].join("\n") + "\n",
    );
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/no red-gate pass since the contracts were last frozen/);
  });

  test("redPassStandsForCurrentContracts: pure ordering check", () => {
    const freeze = { guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (1 contract file)" };
    const red = { guard: "red-gate", verdict: "pass", summary: "RED OK" };
    const redBlock = { guard: "red-gate", verdict: "block", summary: "1 wrong-reason failure" };
    expect(redPassStandsForCurrentContracts([freeze, red])).toBe(true);
    expect(redPassStandsForCurrentContracts([red, freeze])).toBe(false);
    expect(redPassStandsForCurrentContracts([freeze, redBlock])).toBe(false);
    expect(redPassStandsForCurrentContracts([freeze, red, freeze])).toBe(false);
    // A checksum VERIFY (no drift) is not a freeze — it must not void the red.
    const verify = { guard: "checksum-gate", verdict: "pass", summary: "OK (1 contract file, no drift)" };
    expect(redPassStandsForCurrentContracts([freeze, red, verify])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Green is bound to the TESTS the red proved, not just to the contracts
// ---------------------------------------------------------------------------
//
// Red now runs against a shadow project (red-gate.ts) so the test-writer and
// the builder can work in parallel. The price of that freedom is that the two
// move independently: a test edited after the red passed has never been shown
// to fail, and a green over it is the Run 10 false green in new clothes. So the
// red records the hash of the tests tree it ran against, and green refuses
// unless the tree still hashes the same.

describe("redBindingFor (pure)", () => {
  const freeze = { guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (1 contract file)" };
  const red = (hash: string) => ({
    guard: "red-gate",
    verdict: "pass",
    summary: "RED OK",
    detail: { testsTreeHash: hash },
  });

  test("a red for the current contracts AND the current tests binds", () => {
    expect(redBindingFor([freeze, red("abc")], "abc")).toEqual({ ok: true });
  });

  test("a red whose tests have since moved does not bind", () => {
    expect(redBindingFor([freeze, red("abc")], "def")).toEqual({ ok: false, reason: "tests-changed" });
  });

  test("no red since the freeze outranks any hash question", () => {
    expect(redBindingFor([red("abc"), freeze], "abc")).toEqual({ ok: false, reason: "no-red" });
    expect(redBindingFor([], "abc")).toEqual({ ok: false, reason: "no-red" });
  });

  test("a red that recorded no hash proves nothing about these tests", () => {
    const unhashed = { guard: "red-gate", verdict: "pass", summary: "RED OK" };
    expect(redBindingFor([freeze, unhashed], "abc")).toEqual({ ok: false, reason: "unbound-red" });
  });

  test("the LATEST red is the one that counts", () => {
    expect(redBindingFor([freeze, red("old"), red("new")], "new")).toEqual({ ok: true });
    expect(redBindingFor([freeze, red("new"), red("old")], "new")).toEqual({ ok: false, reason: "tests-changed" });
  });
});

describe("green-gate CLI: the tests must be the ones the red proved", () => {
  const allPassing = vitestJson([{ name: "renews", status: "passed" }]);

  function withTests(prefix: string, source: string): string {
    const dir = fixtureRepo(prefix, allPassing);
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "billing.test.ts"), source);
    seedRedPass(dir); // red passed against the tests as written above
    return dir;
  }

  test("hashes match → green passes on the live tree as before", () => {
    const dir = withTests("green-hashok-", "// the tests the red ran against\n");
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/green-gate: OK — 1 passed, 1 total/);
  });

  test("a test edited after the red → refused, routed to the test-writer", () => {
    const dir = withTests("green-hashdrift-", "// the tests the red ran against\n");
    writeFileSync(join(dir, "tests", "billing.test.ts"), "// edited after the red went green\n");
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("green-gate: FAIL — tests/ has changed since the red-gate pass that covers it");
    expect(r.stdout).toContain("  Re-run red_gate — it builds its own shadow project, so it neither needs nor");
    expect(r.stdout).toContain("green-gate: route → test-writer");
    expect(greenEntry(dir)).toMatchObject({
      guard: "green-gate",
      verdict: "block",
      summary: "tests changed since the red",
      detail: { reason: "tests-changed", route: "test-writer" },
    });
  });

  test("a NEW test file added after the red is an edit too", () => {
    const dir = withTests("green-hashadd-", "// the tests the red ran against\n");
    writeFileSync(join(dir, "tests", "extra.test.ts"), "// written after the red\n");
    expect(runGate(dir).status).toBe(1);
  });

  test("the refusal happens before the suite runs — nothing is measured against unproven tests", () => {
    const dir = withTests("green-hashearly-", "// the tests the red ran against\n");
    writeFileSync(join(dir, "tests", "billing.test.ts"), "// edited\n");
    rmSync(join(dir, "run.json")); // the suite could not run even if it wanted to
    const r = runGate(dir);
    expect(r.status).toBe(1);
    // Not "suite did not run": the gate never got that far.
    expect(r.stdout).toContain("green-gate: FAIL — tests/ has changed since the red-gate pass that covers it");
    expect(r.stdout).not.toMatch(/suite did not run/);
  });

  test("a red from before the binding existed records no hash and is refused", () => {
    const dir = withTests("green-unbound-", "// the tests the red ran against\n");
    writeFileSync(
      join(dir, ".bounded", "guard-log.jsonl"),
      [
        JSON.stringify({ ts: "2026-09-04T00:00:00.000Z", guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (1 contract file)" }),
        JSON.stringify({ ts: "2026-09-04T00:01:00.000Z", guard: "red-gate", verdict: "pass", summary: "RED OK (5 NotImplemented failures, 0 passed)" }),
      ].join("\n") + "\n",
    );
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      "green-gate: FAIL — the standing red-gate pass recorded no tests hash, so no red covers these tests",
    );
    expect(r.stdout).toContain("green-gate: route → test-writer");
  });
});
