import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { logGuardEvent, readGuardLog } from "../../../src/guard-log.ts";
import { generatedFileGlobs, pathLayoutFor } from "../../../src/pack-contrib.ts";
import { classifyGreen, redBindingFor, redPassStandsForCurrentContracts, routeAfterRepeat, runGreenGate } from "./green-gate.ts";
import { cannedGateEnv, type CannedCase, withEnv } from "./junit-fixture.test-support.ts";
import { combineDecisions } from "./phase-policy.ts";
import type { PhaseTestDecision } from "../pack.ts";
import { CONTEXT_SRC, type Fixture, pipelineProject, placeStage } from "./pipeline-fixture.test-support.ts";
import { emitProject, projectFactsOf } from "./project-emitters.ts";
import { testFilesHash } from "./red-gate.ts";
import type { RunTestsResult } from "./run-tests.ts";
import { runScaffold } from "./scaffold-project.ts";
import type { TypecheckResult } from "./typecheck.ts";

// The layout a hexagonal ts project composes (pack contrib data): who owns
// each file a diagnostic names.
const TS_ZONE = pathLayoutFor(["ts", "ts-hexagonal"]);

const RL = "contexts/library/src/domain/reading-list";
const TEST_TYPE_ERR = `${RL}/reading-list.test.ts(12,5): error TS2532: Object is possibly 'undefined'.`;
const SRC_TYPE_ERR = `${RL}/reading-list.ts(4,3): error TS2345: Argument of type 'string'…`;
const CONTRACT_TYPE_ERR = `${RL}/reading-list.contract.ts(9,1): error TS2304: Cannot find name 'Isbn'.`;

/** A clean typecheck — the precondition every pre-#7 green implicitly assumed. */
const TYPE_CLEAN: TypecheckResult = { ok: true, errorCount: 0, diagnostics: [] };

function tsc(...diagnostics: string[]): TypecheckResult {
  return { ok: false, errorCount: diagnostics.length, diagnostics };
}

// --- pure core: classifyGreen -------------------------------------------------

function run(partial: Partial<RunTestsResult>): RunTestsResult {
  return { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, results: [], ...partial };
}





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

describe("the red that covers a green", () => {
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
    detail: { testFilesHash: hash },
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

// --- the gate on the monorepo (canned suite, real lint, surface and skeleton scans) ---

const fixtures: Fixture[] = [];
afterAll(() => { for (const f of fixtures) f.cleanup(); });

/** The notebook pipeline, built: design scaffolded, tests and implementation in. */
function built(): Fixture {
  const f = pipelineProject(["design"]);
  fixtures.push(f);
  expect(runScaffold(f.dir).code).toBe(0);
  placeStage(f.dir, "tests", f.scope);
  placeStage(f.dir, "build", f.scope);
  return f;
}

/** A standing red for the tree as it is: a freeze, then a red pass bound to its test files. */
function standingRed(dir: string, detail: Record<string, unknown> = { testFilesHash: testFilesHash(dir) }): void {
  logGuardEvent(dir, { guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (5 contract files)" });
  logGuardEvent(dir, { guard: "red-gate", verdict: "pass", summary: "RED OK", detail });
}

const ALL_PASS: readonly CannedCase[] = [
  { name: "Note > equals", status: "passed" },
  { name: "CreateNoteHandler > creates the note and saves it", status: "passed" },
];

function green(f: Fixture, cases: readonly CannedCase[] = ALL_PASS, typecheck: { output?: string; code?: number } = {}) {
  return withEnv(cannedGateEnv(f.dir, cases, typecheck), () => runGreenGate(f.dir));
}

const greenEvent = (dir: string) => readGuardLog(dir).filter((e) => e.guard === "green-gate").at(-1);

describe("runGreenGate on the monorepo", () => {
  test("a built project with a standing red is green, and says it was type-clean", async () => {
    const f = built();
    standingRed(f.dir);
    const r = await green(f);
    expect(r.lines).toEqual(["green-gate: OK — 2 passed, 2 total, typecheck clean"]);
    expect(r).toMatchObject({ code: 0, verdict: "pass" });
    expect(r.lines[0]).toBe("green-gate: OK — 2 passed, 2 total, typecheck clean");
    expect(greenEvent(f.dir)).toMatchObject({ verdict: "pass" });
  });

  test("a failing test is named, routed to the builder and logged", async () => {
    const f = built();
    standingRed(f.dir);
    const r = await green(f, [...ALL_PASS, { name: "ListNotesHandler > lists", status: "failed", message: "error: expected 2 to be 3" }]);
    expect(r.code).toBe(1);
    expect(r.lines).toContain("  failed: ListNotesHandler > lists");
    expect(r.lines).toContain("green-gate: route → builder");
    expect(greenEvent(f.dir)).toMatchObject({ verdict: "block", detail: { reason: "failures", names: ["ListNotesHandler > lists"] } });
  });

  test("a skipped or todo test is not a pass (ADR 2026-064: nothing is skipped at green)", async () => {
    const f = built();
    standingRed(f.dir);
    const r = await green(f, [...ALL_PASS, { name: "NoteText laws > parse accepts", status: "skipped" }, { name: "later", status: "todo" }]);
    expect(r).toMatchObject({ code: 1, detail: { reason: "skipped", names: ["NoteText laws > parse accepts", "later"] } });
    expect(r.lines).toContain("  not run: NoteText laws > parse accepts (skipped)");
    expect(r.lines).toContain("green-gate: route → test-writer");
  });

  test("a type error in a test file routes to the test-writer (#7)", async () => {
    const f = built();
    standingRed(f.dir);
    const r = await green(f, ALL_PASS, { output: `${CONTEXT_SRC}/domain/notes/note.test.ts(3,1): error TS2532: Object is possibly 'undefined'.\n`, code: 2 });
    expect(r.lines[0]).toMatch(/1 type error; the suite passes/);
    expect(r.lines).toContain("green-gate: route → test-writer");
  });

  test("an escape hatch in the builder's source blocks and routes to the builder", async () => {
    const f = built();
    standingRed(f.dir);
    const handler = join(f.dir, CONTEXT_SRC, "application/notes/list-notes/list-notes.handler.ts");
    writeFileSync(handler, readFileSync(handler, "utf8").replace("return this.store.findAll();", "return this.store.findAll() as Promise<Note[]>;"));
    const r = await green(f);
    expect(r).toMatchObject({ code: 1, detail: { reason: "escape-hatches" } });
    expect(r.lines).toContain("green-gate: route → builder");
  });

  test("surface a contract does not declare blocks and routes to the builder", async () => {
    const f = built();
    standingRed(f.dir);
    const handler = join(f.dir, CONTEXT_SRC, "application/notes/list-notes/list-notes.handler.ts");
    writeFileSync(handler, readFileSync(handler, "utf8").replace("  async execute()", "  count(): number {\n    return 0;\n  }\n\n  async execute()"));
    const r = await green(f);
    // The layout lint's handler-shape rule says so too; the surface check is the delivered backstop.
    expect(r).toMatchObject({ code: 1, detail: { surfaceViolations: 1, route: "builder" } });
    expect(r.lines.join("\n")).toContain("ListNotesHandler.count: public member not declared");
  });

  test("a skeleton still throwing reaches green only if nothing runs it — and is then named (r16)", async () => {
    const f = built();
    const impl = join(f.dir, CONTEXT_SRC, "domain/notes/note-id.ts");
    const skeleton = emitProject(projectFactsOf(f.dir, "red"), generatedFileGlobs(f.dir))
      .find((file) => file.path === `${CONTEXT_SRC}/domain/notes/note-id.ts`);
    writeFileSync(impl, skeleton?.content ?? "");
    standingRed(f.dir);
    const r = await green(f);
    expect(r).toMatchObject({ code: 1, detail: { skeletonImports: [`${CONTEXT_SRC}/domain/notes/note-id.ts`], route: "builder" } });
    expect(r.lines).toContain(`  skeleton: ${CONTEXT_SRC}/domain/notes/note-id.ts imports NotImplementedError`);
  });

  // Issue #52: a refusal only the user can clear (the container engine) is
  // routed to the user in the board's own wording, never to a role.
  test("a policy refusal routed to the user prints the board's user wording", async () => {
    const f = built();
    standingRed(f.dir);
    const refusal: PhaseTestDecision = { action: "refuse", reason: "the container engine is not responding: restart it", unsetEnv: [], route: "user" };
    const policy = combineDecisions("green", [{ name: "store-tests-need-a-container-runtime", decision: refusal }]);
    const r = await withEnv(cannedGateEnv(f.dir, ALL_PASS), () => runGreenGate(f.dir, { policy }));
    expect(r).toMatchObject({ code: 1, verdict: "block", detail: { reason: "test-policy", route: "user" } });
    expect(r.lines).toContain("green-gate: route → user");
    expect(r.lines).not.toContain("green-gate: route → orchestrator");
    expect(greenEvent(f.dir)).toMatchObject({ verdict: "block", detail: { route: "user" } });
  });

  test("the app smoke test is owed at green", async () => {
    const f = built();
    rmSync(join(f.dir, "apps/web/src/server/composition-root.test.ts"));
    standingRed(f.dir);
    const r = await green(f);
    expect(r).toMatchObject({ code: 1, detail: { reason: "obligations", route: "test-writer" } });
    expect(r.lines.join("\n")).toContain("apps/web has no smoke test");
  });
});

describe("green is bound to a red over these contracts and these tests", () => {
  test("no red at all, or a red older than the last freeze, is refused before anything runs", async () => {
    const f = built();
    const none = await green(f);
    expect(none.lines).toContain("green-gate: FAIL — no red-gate pass since the contracts were last frozen");
    expect(none.lines).toContain("green-gate: route → architect");
    logGuardEvent(f.dir, { guard: "red-gate", verdict: "pass", summary: "RED OK", detail: { testFilesHash: testFilesHash(f.dir) } });
    logGuardEvent(f.dir, { guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (5 contract files)" });
    expect((await green(f)).detail).toMatchObject({ reason: "no-red" });
  });

  test("editing any test-side file after the red voids it; so does adding one", async () => {
    const f = built();
    standingRed(f.dir);
    const test = join(f.dir, CONTEXT_SRC, "domain/notes/note.test.ts");
    writeFileSync(test, `${readFileSync(test, "utf8")}// edited after the red\n`);
    // A failing canned run proves the refusal comes first: nothing was measured.
    const edited = await green(f, [{ name: "x", status: "failed", message: "error: boom" }]);
    expect(edited).toMatchObject({ code: 1, detail: { reason: "tests-changed", route: "test-writer" } });
    expect(edited.lines[0]).toBe("green-gate: FAIL — a test-side file has changed since the red-gate pass that covers it");

    const g = built();
    standingRed(g.dir);
    writeFileSync(join(g.dir, CONTEXT_SRC, "application/notes/list-notes/extra.test.ts"), "// new\n");
    expect((await green(g)).detail).toMatchObject({ reason: "tests-changed" });
  });

  test("a red that recorded only the retired tests-tree hash binds nothing", async () => {
    const f = built();
    standingRed(f.dir, { testsTreeHash: "abc" });
    expect((await green(f)).detail).toMatchObject({ reason: "unbound-red" });
  });

  test("an unreadable composition is an error, not a verdict", async () => {
    const f = built();
    standingRed(f.dir);
    rmSync(join(f.dir, ".bounded/composed-packs.json"));
    expect(await green(f)).toMatchObject({ code: 2, verdict: "error" });
  });
});
