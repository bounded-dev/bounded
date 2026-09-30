import { writeProjectPacks } from "../../../src/project-composition.ts";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync as createTempDir,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import {
  classifyRed,
  collectRedGateSources,
  isNotImplementedFailure,
  isForwardTypeImportDiagnostic,
  isSkeletonForwardTypeImportDiagnostic,
  materializeShadowProject,
  redGateProjectPlan,
  runRedGate,
  SHADOW_RELATIVE,
  shadowProjectDir,
  testsTreeHash,
  typecheckShadowWithForwardImports,
} from "./red-gate.ts";
import type { RunTestsResult } from "./run-tests.ts";
import type { TypecheckResult } from "./typecheck.ts";
import { readGuardLog } from "../../../src/guard-log.ts";
import { applyInit, planInit } from "../../../src/project-init.ts";
import { runRecordDesignReview } from "./design-review.ts";

import { pathLayoutFor } from "../../../src/pack-contrib.ts";

// The layout a hexagonal ts project composes (pack contrib data): who owns
// each file a diagnostic names.
const TS_ZONE = pathLayoutFor(["ts", "ts-hexagonal"]);

const SERVICE_RUNTIME = join(import.meta.dirname, "../../ts-trpc/api/service-runtime.ts");

// --- vitest-JSON fixture builders --------------------------------------------

interface Case {
  name: string;
  status: string;
  message?: string;
}

/** Minimal `vitest --reporter=json` document with one test file. */
function vitestJson(cases: Case[]): string {
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

/** A vitest doc where a whole file failed to collect (import error): no
 *  per-test assertions, a file-level failure message. */
function importErrorJson(message: string): string {
  return JSON.stringify({
    testResults: [{ status: "failed", assertionResults: [], message }],
  });
}

const NI = "NotImplementedError: NotImplemented: create\n    at /tmp/proj/src/orders.ts:5:11";

// --- pure core: classifyRed ---------------------------------------------------

function run(partial: Partial<RunTestsResult>): RunTestsResult {
  return { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, results: [], ...partial };
}

/** A clean typecheck: the TEST phase's other precondition (#7). */
const TYPE_CLEAN: TypecheckResult = { ok: true, errorCount: 0, diagnostics: [] };

function tsc(...diagnostics: string[]): TypecheckResult {
  return { ok: false, errorCount: diagnostics.length, diagnostics };
}

const TEST_TYPE_ERR = "contexts/shop/src/domain/orders/orders.test.ts(12,5): error TS2532: Object is possibly 'undefined'.";
const CONTRACT_TYPE_ERR = "contexts/shop/src/domain/orders/orders.contract.ts(9,1): error TS2304: Cannot find name 'Isbn'.";

describe("isNotImplementedFailure", () => {
  test("matches a NotImplementedError message by name", () => {
    expect(isNotImplementedFailure("NotImplementedError: NotImplemented: foo")).toBe(true);
  });
  test("rejects an ordinary assertion failure", () => {
    expect(isNotImplementedFailure("AssertionError: expected 1 to be 2")).toBe(false);
    expect(isNotImplementedFailure(undefined)).toBe(false);
  });
});

describe("classifyRed", () => {
  test("valid red: every failure is NotImplemented → exit 0", () => {
    const r = classifyRed(
      run({
        total: 2,
        failed: 2,
        results: [
          { name: "a", status: "failed", message: "NotImplementedError: NotImplemented: a" },
          { name: "b", status: "failed", message: "NotImplementedError: NotImplemented: b" },
        ],
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(0);
    expect(r.verdict).toBe("pass");
    expect(r.lines[0]).toMatch(/red-gate: OK — 2 NotImplemented failures/);
  });

  test("a NotImplemented failure cannot hide a test that passes on the skeleton", () => {
    const r = classifyRed(
      run({
        total: 2,
        passed: 1,
        failed: 1,
        results: [
          { name: "a", status: "passed" },
          { name: "b", status: "failed", message: "NotImplementedError: NotImplemented: b" },
        ],
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(1);
    expect(r.verdict).toBe("block");
    expect(r.lines).toContain("  passed against skeleton: a");
    expect(r.lines).toContain("red-gate: route → test-writer");
    expect(r.detail).toMatchObject({ reason: "spurious-pass", passing: ["a"] });
  });

  test("a NotImplemented failure cannot hide a skipped test", () => {
    const r = classifyRed(
      run({
        total: 2,
        failed: 1,
        skipped: 1,
        results: [
          { name: "calls create", status: "failed", message: "NotImplementedError: NotImplemented: create" },
          { name: "untested boundary", status: "skipped" },
        ],
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(1);
    expect(r.lines).toContain("  did not fail: untested boundary (skipped)");
    expect(r.lines).toContain("red-gate: route → test-writer");
    expect(r.detail).toMatchObject({ reason: "non-red-tests", inconclusive: [{ name: "untested boundary", status: "skipped" }] });
  });

  test("an unknown reporter status cannot hide beside a NotImplemented failure", () => {
    const r = classifyRed(
      run({
        total: 2,
        failed: 1,
        results: [
          { name: "calls create", status: "failed", message: "NotImplementedError: NotImplemented: create" },
          { name: "unclassified case", status: "unknown" },
        ],
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(1);
    expect(r.lines).toContain("  did not fail: unclassified case (unknown)");
    expect(r.detail).toMatchObject({ reason: "non-red-tests" });
  });

  test("wrong-reason red: an ordinary assertion failure → exit 1, named", () => {
    const r = classifyRed(
      run({
        total: 2,
        failed: 2,
        results: [
          { name: "impl pending", status: "failed", message: "NotImplementedError: NotImplemented: a" },
          { name: "math is wrong", status: "failed", message: "AssertionError: expected 1 to be 2" },
        ],
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/wrong-reason red/);
    expect(r.lines.join("\n")).toContain("wrong-reason: math is wrong — AssertionError: expected 1 to be 2");
    expect(r.lines.join("\n")).not.toContain("impl pending");
  });

  test("blocked suite (import/config error) → exit 1", () => {
    const r = classifyRed(run({ blocked: "Error: Cannot find module [path]" }), TYPE_CLEAN);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/suite did not run/);
  });

  test("fully-passing suite at red phase → exit 1", () => {
    const r = classifyRed(
      run({ total: 2, passed: 2, results: [{ name: "a", status: "passed" }, { name: "b", status: "passed" }] }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/suite fully passes/);
  });

  test("no tests ran → exit 1", () => {
    const r = classifyRed(run({ total: 0 }), TYPE_CLEAN);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/no tests ran/);
  });

  test("a compiler failure without TS diagnostics cannot pass red", () => {
    const r = classifyRed(
      run({ total: 1, failed: 1, results: [{ name: "a", status: "failed", message: NI }] }),
      { ok: false, errorCount: 0, diagnostics: ["compiler exited before reporting diagnostics"] },
    );
    expect(r).toMatchObject({ code: 1, verdict: "block", detail: { reason: "typecheck-failed" } });
    expect(r.lines.join("\n")).toContain("compiler exited before reporting diagnostics");
  });

  // --- #7: catch test-file type errors at TEST, not at the false green -------
  // Run 3's two tsc errors sat in tests/** through the whole BUILD phase; the
  // builder is blind to tests/** and can never fix them. Reject red here.

  test("a valid red with type errors is still rejected", () => {
    const r = classifyRed(
      run({
        total: 1,
        failed: 1,
        results: [{ name: "a", status: "failed", message: "NotImplementedError: NotImplemented: a" }],
      }),
      tsc(TEST_TYPE_ERR),
      TS_ZONE,
    );
    expect(r.code).toBe(1);
    expect(r.verdict).toBe("block");
    expect(r.lines[0]).toMatch(/red-gate: FAIL — 1 type error/);
    expect(r.lines[0]).toMatch(/red is valid but the project is not type-clean/);
    expect(r.lines).toContain("red-gate: route → test-writer");
    expect(r.detail).toMatchObject({ route: "test-writer", typeErrors: 1 });
  });

  test("a contract type error at TEST routes upstream to the architect", () => {
    const r = classifyRed(
      run({
        total: 1,
        failed: 1,
        results: [{ name: "a", status: "failed", message: "NotImplementedError: NotImplemented: a" }],
      }),
      tsc(CONTRACT_TYPE_ERR, TEST_TYPE_ERR),
      TS_ZONE,
    );
    expect(r.lines).toContain("red-gate: route → architect");
    expect(r.lines.join("\n")).toContain("  typecheck: 2 type errors");
  });

  test("a wrong-reason red reports both problems and routes to the test-writer", () => {
    const r = classifyRed(
      run({
        total: 1,
        failed: 1,
        results: [{ name: "math", status: "failed", message: "AssertionError: expected 1 to be 2" }],
      }),
      tsc(TEST_TYPE_ERR),
      TS_ZONE,
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/wrong-reason red/);
    expect(r.lines.join("\n")).toContain("  typecheck: 1 type error");
    expect(r.lines).toContain("red-gate: route → test-writer");
  });

  test("valid red on a type-clean project says so, so the pass is auditable", () => {
    const r = classifyRed(
      run({
        total: 1,
        failed: 1,
        results: [{ name: "a", status: "failed", message: "NotImplementedError: NotImplemented: a" }],
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/typecheck clean/);
  });
});

const CONTRACT = `export declare class Currency {
  private readonly __brand: "Currency";
  private constructor();
  readonly code: string;
  static parse(raw: unknown): Currency | undefined;
}
`;

// --- CLI (fixture-repo): real subprocess, real exit codes, real guard log -----

const SCRIPT = join(import.meta.dirname, "red-gate.ts");
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A target project whose "test suite" is `cat run.json` (canned vitest JSON),
 *  wired via the BOUNDED_GATE_TEST_CMD seam so no real vitest install is needed.
 *
 *  The repo also carries a real contract and a real test file, because the gate
 *  now builds a PRISTINE project before running anything and a project with no
 *  contracts (or no tests) cannot produce a valid red at all. The canned files
 *  are addressed absolutely, since the suite runs in the shadow project rather
 *  than here. */
function fixtureRepo(prefix: string, runJson: string, file = "run.json", tscOutput = ""): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  writeFileSync(join(dir, file), runJson);
  writeFileSync(join(dir, "tsc.txt"), tscOutput);
  mkdirSync(join(dir, "src", "money"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "src", "money", "money.contract.ts"), "export declare function create(): void;\n");
  writeFileSync(join(dir, "tests", "money.test.ts"), "// canned\n");
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
  return dir;
}

function runGate(dir: string, file = "run.json", typeErrors = false) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      BOUNDED_GATE_TEST_CMD: "cat",
      BOUNDED_GATE_TEST_ARGS: JSON.stringify([join(dir, file)]),
      // tsc stand-in: replay a captured diagnostics file with tsc's exit code.
      BOUNDED_GATE_TSC_CMD: "sh",
      BOUNDED_GATE_TSC_ARGS: JSON.stringify(["-c", `cat ${join(dir, "tsc.txt")}; exit ${typeErrors ? 2 : 0}`]),
    },
  });
}

describe("red-gate CLI (fixture repos)", () => {
  test("NotImplemented-red target → exit 0 and a logged pass", () => {
    const dir = fixtureRepo("red-ni-", vitestJson([{ name: "create order", status: "failed", message: NI }]));
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/red-gate: OK — 1 NotImplemented failure/);
    // The gate now also lints test sources, which logs its own entry first.
    expect(readGuardLog(dir).find((e) => e.guard === "red-gate")).toMatchObject({ guard: "red-gate", verdict: "pass" });
  });

  test("wrong-reason red (import error) → exit 1 and a logged block", () => {
    const dir = fixtureRepo(
      "red-import-",
      importErrorJson("Error: Cannot find module './missing' imported from /tmp/proj/tests/orders.test.ts"),
    );
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/wrong-reason red/);
    const ev = readGuardLog(dir).find((e) => e.guard === "red-gate")!;
    expect(ev).toMatchObject({ guard: "red-gate", verdict: "block" });
    expect(ev.summary).toMatch(/wrong-reason/);
  });

  test("fully-green target at red phase → exit 1", () => {
    const dir = fixtureRepo("red-green-", vitestJson([{ name: "already done", status: "passed" }]));
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/suite fully passes/);
  });

  test("a mixed suite blocks red and records the passing test", () => {
    const dir = fixtureRepo("red-spurious-", vitestJson([
      { name: "works without an implementation", status: "passed" },
      { name: "calls create", status: "failed", message: NI },
    ]));
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("passed against skeleton: works without an implementation");
    expect(readGuardLog(dir).find((e) => e.guard === "red-gate")).toMatchObject({
      verdict: "block",
      detail: { reason: "spurious-pass", passing: ["works without an implementation"], route: "test-writer" },
    });
  });

  test("unparseable suite output (BLOCKED) → exit 1", () => {
    const dir = fixtureRepo("red-blocked-", "not a vitest json report", "garbage.json");
    const r = runGate(dir, "garbage.json");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/suite did not run/);
  });

  test("valid red but type-dirty → exit 1, routed, logged as a block (#7)", () => {
    const dir = fixtureRepo(
      "red-typedirty-",
      vitestJson([{ name: "create order", status: "failed", message: NI }]),
      "run.json",
      `${TEST_TYPE_ERR}\nFound 1 error in tests/orders.test.ts:12\n`,
    );
    const r = runGate(dir, "run.json", true);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/red-gate: FAIL — 1 type error/);
    expect(r.stdout).toContain("red-gate: route → test-writer");
    expect(readGuardLog(dir).find((e) => e.guard === "red-gate")).toMatchObject({
      guard: "red-gate",
      verdict: "block",
      detail: { route: "test-writer", typeErrors: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// Red against a regenerated skeleton — so the builder need not wait
// ---------------------------------------------------------------------------

// The red gate asserts every failure is NotImplementedError, which is only
// measurable against an UNIMPLEMENTED skeleton. That is the sole reason BUILD
// had to wait for the red gate: once the builder writes code, the window shuts.
//
// But that constraint is an artifact of running the gate against the LIVE tree.
// `scaffold` is deterministic and the contracts are checksum-frozen, so the
// unimplemented skeleton can be reproduced at any moment. Run the suite against a
// regenerated copy and the verdict is valid no matter what the builder has done
// to the real src/ — which lets the test-writer and builder work in parallel and
// turns the critical path from sum() into max().
//
// Blindness is untouched: regenerating a skeleton needs the contracts, never
// the tests.

describe("redGateProjectPlan", () => {
  test("takes the tests and contracts, and regenerates the implementation", () => {
    const plan = redGateProjectPlan({
      contracts: ["src/money.contract.ts", "src/plan.contract.ts"],
      testFiles: ["tests/money.test.ts"],
      configFiles: ["package.json", "tsconfig.json"],
    });
    // Copied verbatim: the contracts are the shared interface, the tests are
    // what we are validating, and the config decides how they run.
    expect(plan.copy).toContain("src/money.contract.ts");
    expect(plan.copy).toContain("tests/money.test.ts");
    expect(plan.copy).toContain("package.json");
    expect(plan.copy).toContain("tsconfig.json");
    // Regenerated, never copied — copying it is exactly the bug this avoids.
    expect(plan.regenerate).toEqual(["src/money.contract.ts", "src/plan.contract.ts"]);
  });

  test("never copies implementation files", () => {
    const plan = redGateProjectPlan({
      contracts: ["src/money.contract.ts"],
      testFiles: ["tests/money.test.ts"],
      configFiles: ["package.json"],
      // A builder working in parallel has already written these.
      implementationFiles: ["src/money.ts", "src/subscription.ts", "src/shared/errors.ts"],
    });
    expect(plan.copy).not.toContain("src/money.ts");
    expect(plan.copy).not.toContain("src/subscription.ts");
    // The shared errors module is machine-generated by the scaffolder too.
    expect(plan.copy).not.toContain("src/shared/errors.ts");
  });

  test("a project with no tests cannot produce a valid red", () => {
    expect(() =>
      redGateProjectPlan({ contracts: ["src/x.contract.ts"], testFiles: [], configFiles: [] }),
    ).toThrow(/no tests/i);
  });

  test("a project with no contracts cannot regenerate anything", () => {
    expect(() =>
      redGateProjectPlan({ contracts: [], testFiles: ["tests/x.test.ts"], configFiles: [] }),
    ).toThrow(/no contract/i);
  });
});

// --- The shadow project (the plan, materialized) ----------------------------------
//
// The point of these: the red verdict must not depend on what the builder has
// done to the live src/. Everything below builds a tree in which the builder has
// ALREADY written a full implementation, and asserts the gate's project is
// untouched by it.

function liveTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-red-live-"));
  mkdirSync(join(dir, "src", "money"), { recursive: true });
  mkdirSync(join(dir, "tests", "generated"), { recursive: true });
  writeFileSync(join(dir, "src", "money", "money.contract.ts"), CONTRACT);
  // The builder, working in parallel, has already finished.
  writeFileSync(join(dir, "src", "money", "money.ts"), "export class Currency { static parse() { return undefined; } }\n");
  writeFileSync(join(dir, "src", "shared", "errors.ts".replace("errors.ts", "")) + "errors.ts", "// stale\n");
  writeFileSync(join(dir, "tests", "money.test.ts"), "// test\n");
  writeFileSync(join(dir, "tests", "generated", "money.laws.test.ts"), "// generated laws\n");
  writeFileSync(join(dir, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  return dir;
}

describe("collectRedGateSources", () => {
  const dir = liveTree();
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("separates contracts from the implementation the builder wrote", () => {
    const sources = collectRedGateSources(dir);
    expect(sources.contracts).toEqual(["src/money/money.contract.ts"]);
    expect(sources.implementationFiles).toContain("src/money/money.ts");
    expect(sources.implementationFiles).not.toContain("src/money/money.contract.ts");
  });

  test("takes the generated law suite as well as the hand-written tests", () => {
    const sources = collectRedGateSources(dir);
    expect(sources.testFiles).toContain("tests/money.test.ts");
    expect(sources.testFiles).toContain("tests/generated/money.laws.test.ts");
  });

  test("takes only the config files that exist", () => {
    const sources = collectRedGateSources(dir);
    expect(sources.configFiles).toEqual(["package.json", "tsconfig.json"]);
  });

  test("copies every root file the composed packs name as config, the bundler's included", () => {
    const web = liveTree();
    try {
      // ADR 2026-062: Bun's config names replaced Vite's and Vitest's.
      writeFileSync(join(web, "bunfig.toml"), "[test]\n");
      writeFileSync(join(web, "bun.lock"), "{}\n");
      writeFileSync(join(web, "notes.md"), "not config\n");
      expect(collectRedGateSources(web).configFiles)
        .toEqual(["bun.lock", "bunfig.toml", "package.json", "tsconfig.json"]);
    } finally {
      rmSync(web, { recursive: true, force: true });
    }
  });
});

describe("materializeShadowProject", () => {
  const live = liveTree();
  const shadow = materializeShadowProject(live, redGateProjectPlan(collectRedGateSources(live)));
  afterAll(() => rmSync(live, { recursive: true, force: true }));

  test("builds inside the project's own .bounded, which delivery already gitignores", () => {
    expect(shadow).toBe(join(live, ".bounded", "shadow-red"));
    expect(shadowProjectDir(live)).toBe(shadow);
    expect(SHADOW_RELATIVE).toBe(".bounded/shadow-red");
  });

  test("regenerates the skeleton instead of copying the implementation", () => {
    const skeleton = readFileSync(join(shadow, "src", "money", "money.ts"), "utf8");
    expect(skeleton).toContain("GENERATED from money.contract.ts");
    expect(skeleton).toContain('throw new NotImplementedError("Currency.parse")');
    // The builder's real implementation must not have reached the copy: it is
    // what turns NotImplemented failures into ordinary assertion failures.
    expect(skeleton).not.toContain("static parse() { return undefined; }");
  });

  test("regenerates the shared errors module rather than trusting the live one", () => {
    const errors = readFileSync(join(shadow, "src", "shared", "errors.ts"), "utf8");
    expect(errors).toContain("class NotImplementedError");
    expect(errors).not.toContain("stale");
  });

  test("carries the tests and the config across verbatim", () => {
    expect(readFileSync(join(shadow, "tests", "money.test.ts"), "utf8")).toContain("// test");
    expect(readFileSync(join(shadow, "tests", "generated", "money.laws.test.ts"), "utf8")).toContain("laws");
    expect(existsSync(join(shadow, "package.json"))).toBe(true);
    expect(existsSync(join(shadow, "tsconfig.json"))).toBe(true);
  });

  test("leaves the live tree alone", () => {
    // The gate must never write into the project it is judging.
    expect(readFileSync(join(live, "src", "money", "money.ts"), "utf8")).toContain("static parse() { return undefined; }");
  });
});

describe("contract-triggered support and forward types", () => {
  const live = createTempDir(join(tmpdir(), "pi-red-forward-"));
  writeProjectPacks(live, ["ts", "ts-hexagonal", "ts-trpc"]);
  mkdirSync(join(live, "src", "api"), { recursive: true });
  mkdirSync(join(live, "tests"), { recursive: true });
  writeFileSync(join(live, "src/api/api.contract.ts"),
    'import type { Ack } from "./service-runtime.js";\n' +
    'import type { serviceRouter } from "./api.js";\n' +
    'export type ServiceRouter = typeof serviceRouter;\n' +
    'export declare function submit(): Ack;\n');
  writeFileSync(join(live, "src/api/api.ts"), "export const serviceRouter = { submit: true };\n");
  writeFileSync(join(live, "tests/api.test.ts"), "// pending\n");
  afterAll(() => rmSync(live, { recursive: true, force: true }));

  test("regenerates the canonical service runtime without copying the business implementation", () => {
    const plan = redGateProjectPlan(collectRedGateSources(live));
    expect(plan.copy).not.toContain("src/api/api.ts");
    const shadow = materializeShadowProject(live, plan);
    expect(readFileSync(join(shadow, "src/api/service-runtime.ts"), "utf8"))
      .toBe(readFileSync(SERVICE_RUNTIME, "utf8")
        .replace(/^/, "// GENERATED from packs/ts-trpc/api/service-runtime.ts by packs/ts/scripts/scaffold-contract.ts — do not edit.\n"));
    expect(readFileSync(join(shadow, "src/api/api.ts"), "utf8"))
      .not.toContain("serviceRouter = { submit: true }");
  });

  test("with only ts composed, the shadow gets no service runtime (ADR 2026-046)", () => {
    const bare = createTempDir(join(tmpdir(), "pi-red-bare-"));
    try {
      writeProjectPacks(bare, ["ts"]);
      mkdirSync(join(bare, "src", "api"), { recursive: true });
      mkdirSync(join(bare, "tests"), { recursive: true });
      writeFileSync(join(bare, "src/api/api.contract.ts"), readFileSync(join(live, "src/api/api.contract.ts"), "utf8"));
      writeFileSync(join(bare, "tests/api.test.ts"), "// pending\n");
      const shadow = materializeShadowProject(bare, redGateProjectPlan(collectRedGateSources(bare)));
      expect(existsSync(join(shadow, "src/api/api.ts"))).toBe(true);
      expect(existsSync(join(shadow, "src/api/service-runtime.ts"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("a support import escaping src/ is refused before the shadow writes it", () => {
    const escaping = createTempDir(join(tmpdir(), "pi-red-escape-"));
    try {
      writeProjectPacks(escaping, ["ts", "ts-hexagonal", "ts-trpc"]);
      mkdirSync(join(escaping, "src", "api"), { recursive: true });
      mkdirSync(join(escaping, "tests"), { recursive: true });
      writeFileSync(join(escaping, "src/api/api.contract.ts"),
        'import type { Ack } from "../../../x/service-runtime.js";\nexport declare function submit(): Ack;\n');
      writeFileSync(join(escaping, "tests/api.test.ts"), "// pending\n");
      expect(() => materializeShadowProject(escaping, redGateProjectPlan(collectRedGateSources(escaping))))
        .toThrow("red-gate: src/api/api.contract.ts asks for the API-service runtime at '../x/service-runtime.ts', which resolves outside the project's src/");
    } finally {
      rmSync(escaping, { recursive: true, force: true });
    }
  });

  test("recognizes only a type-only forward import of a real sibling export", () => {
    const matching = 'src/api/api.contract.ts(2,15): error TS2724: \'"./api.js"\' has no exported member named \'serviceRouter\'. Did you mean \'ServiceRouter\'?';
    expect(isForwardTypeImportDiagnostic(live, matching)).toBe(true);
    expect(isForwardTypeImportDiagnostic(live, matching.replace("(2,15)", "(4,15)"))).toBe(false);
    expect(isForwardTypeImportDiagnostic(live, matching.replace("serviceRouter'.", "missing'."))).toBe(false);
    expect(isForwardTypeImportDiagnostic(live, matching.replace("TS2724", "TS2307"))).toBe(false);
  });

  test("at first freeze, accepts the forward import only while the sibling is a generated skeleton", () => {
    const matching = 'src/api/api.contract.ts(2,15): error TS2724: \'"./api.js"\' has no exported member named \'serviceRouter\'. Did you mean \'ServiceRouter\'?';
    const impl = join(live, "src/api/api.ts");
    const built = readFileSync(impl, "utf8");
    try {
      expect(isSkeletonForwardTypeImportDiagnostic(live, matching)).toBe(false); // a hand-written implementation
      writeFileSync(impl, "// GENERATED from api.contract.ts by packs/ts/scripts/scaffold-contract.ts — do not edit.\nexport {};\n");
      expect(isSkeletonForwardTypeImportDiagnostic(live, matching)).toBe(true);
      expect(isForwardTypeImportDiagnostic(live, matching)).toBe(false);
      expect(isSkeletonForwardTypeImportDiagnostic(live, matching.replace("(2,15)", "(4,15)"))).toBe(false);
      expect(isSkeletonForwardTypeImportDiagnostic(live, matching.replace("TS2724", "TS2307"))).toBe(false);
    } finally {
      writeFileSync(impl, built);
    }
  });

  test("accepts the forward type only when the live project typechecks", async () => {
    writeFileSync(join(live, "package.json"), '{"type":"module"}\n');
    writeFileSync(join(live, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true },
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }));
    symlinkSync(join(import.meta.dirname, "../../../node_modules"), join(live, "node_modules"), "dir");
    const impl = join(live, "src/api/api.ts");
    const original = readFileSync(impl, "utf8");
    writeFileSync(impl, 'import type { Ack } from "./service-runtime.js";\nexport const serviceRouter = { submit: true };\nexport function submit(): Ack { return { outcome: "applied" }; }\n');
    try {
      // The real project has the same shipped support file as the shadow.
      writeFileSync(join(live, "src/api/service-runtime.ts"),
        readFileSync(SERVICE_RUNTIME, "utf8"));
      const shadow = materializeShadowProject(live, redGateProjectPlan(collectRedGateSources(live)));
      expect(await typecheckShadowWithForwardImports(live, shadow)).toMatchObject({ ok: true, errorCount: 0 });

      writeFileSync(impl, original + "missingName();\n");
      const blocked = await typecheckShadowWithForwardImports(live, shadow);
      expect(blocked.ok).toBe(false);
      expect(blocked.diagnostics.join("\n")).toContain("missingName");
    } finally {
      writeFileSync(impl, original);
    }
  });

  test("a real red run passes with generated support and a verified forward type", async () => {
    writeFileSync(join(live, "package.json"), '{"type":"module"}\n');
    writeFileSync(join(live, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true },
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }));
    if (!existsSync(join(live, "node_modules"))) {
      symlinkSync(join(import.meta.dirname, "../../../node_modules"), join(live, "node_modules"), "dir");
    }
    writeFileSync(join(live, "src/api/service-runtime.ts"),
      readFileSync(SERVICE_RUNTIME, "utf8"));
    writeFileSync(join(live, "src/api/api.ts"),
      'import type { Ack } from "./service-runtime.js";\nexport const serviceRouter = { submit: true };\nexport function submit(): Ack { return { outcome: "applied" }; }\n');
    writeFileSync(join(live, "tests/api.test.ts"),
      'import { test } from "vitest";\nimport { submit } from "../src/api/api.js";\ntest("submit waits for implementation", () => { submit(); });\n');
    const result = await runRedGate(live);
    expect(result).toMatchObject({ code: 0, verdict: "pass" });
    expect(result.summary).toContain("NotImplemented failure");
    expect(readFileSync(join(live, ".bounded/shadow-red/src/api/api.ts"), "utf8"))
      .not.toContain("serviceRouter = { submit: true }");
  });
});

// Skipped by WI-4 (ADR 2026-062): this drives the retired flat layout with
// Vitest tests through the real gates. A generated project now type-checks
// only its composed source roots and runs `bun test`, so the flat tree has no
// inputs. WI-8 rebuilds this end-to-end on the monorepo.
test.skip("project-local init, design freeze, inferred router re-freeze, and red use the copied harness", async () => {
  const dir = createTempDir(join(tmpdir(), "bounded-red-init-"));
  tmpDirs.push(dir);
  const selected = ["ts-trpc"];
  const plan = await planInit(dir, "claude-code", selected);
  await applyInit(dir, "claude-code", selected, plan.digest);
  symlinkSync(join(import.meta.dirname, "../../../node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(dir, "src/api"), { recursive: true });
  writeFileSync(join(dir, "docs/tn/TN-24.md"),
    "---\nissue: 24\nstatus: active\ncontracts:\n  - src/api/api.contract.ts\n---\n\n# Service\n\n## Intake\n\nNothing stripped.\n\nSubmit returns an acknowledgement.\n");
  const priorTicket = process.env.BOUNDED_TICKET;
  process.env.BOUNDED_TICKET = "24";
  try {
  const contract = join(dir, "src/api/api.contract.ts");
  const base = 'export declare function submit(): void;\n';
  writeFileSync(contract, base);
  const copied = join(dir, ".bounded/harness/scripts/bounded");
  const gate = (name: string) => spawnSync("bash", [copied, "gates", name, dir], { cwd: dir, encoding: "utf8" });

  expect(runRecordDesignReview(dir, []).code).toBe(0);
  const firstFreeze = gate("design-gate");
  expect(firstFreeze.status, firstFreeze.stdout + firstFreeze.stderr).toBe(0);
  expect(existsSync(join(dir, ".bounded/tickets/24/contract-checksums.json"))).toBe(true);

  writeFileSync(join(dir, "src/api/api.ts"),
    'import type { Ack } from "./service-runtime.js";\nexport const serviceRouter = { submit: true };\nexport function submit(): Ack { return { outcome: "applied" }; }\n');
  writeFileSync(contract,
    'import type { Ack } from "./service-runtime.js";\n' +
    'import type { serviceRouter } from "./api.js";\n' +
    'export type ServiceRouter = typeof serviceRouter;\n' +
    'export declare function submit(): Ack;\n');
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "tests/api.test.ts"),
    'import { test } from "vitest";\nimport { submit } from "../src/api/api.js";\ntest("submit waits for implementation", () => { submit(); });\n');
  expect(runRecordDesignReview(dir, []).code).toBe(0);
  const secondFreeze = gate("design-gate");
  expect(secondFreeze.status, secondFreeze.stdout + secondFreeze.stderr).toBe(0);
  const red = gate("red-gate");
  expect(red.status, red.stdout + red.stderr).toBe(0);
  expect(red.stdout).toContain("NotImplemented failure");
  expect(readGuardLog(dir).at(-1)).toMatchObject({ guard: "red-gate", verdict: "pass" });
  } finally {
    if (priorTicket === undefined) delete process.env.BOUNDED_TICKET;
    else process.env.BOUNDED_TICKET = priorTicket;
  }
}, 90_000);

// --- TSX in the shadow (TN-26-006 A1) ---------------------------------------
//
// The shadow is only evidence if it is the project the live scaffold step would
// have produced. Two things had to move for that to stay true once components
// exist: the skeleton lands at the SAME extension the live sync would choose,
// and the walk that collects the suite can see a `.tsx` test at all — a test it
// cannot see is a test the shadow never copies, so the red would be measured
// over a suite with a hole in it while reporting its own count as complete.

describe("the shadow project handles components", () => {
  const COMPONENT = `import type { ReactElement } from "react";

export interface BadgeProps {
  readonly tone: "ok" | "warn";
}

export declare function Badge(props: BadgeProps): ReactElement;
`;

  function componentTree(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-red-tsx-"));
    mkdirSync(join(dir, "src", "ui"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "src", "ui", "badge.contract.ts"), COMPONENT);
    // The builder, working in parallel, has already finished.
    writeFileSync(join(dir, "src", "ui", "badge.tsx"), "export function Badge() { return null; }\n");
    writeFileSync(join(dir, "tests", "badge.test.tsx"), "// component test\n");
    writeFileSync(join(dir, "package.json"), '{"name":"x"}\n');
    return dir;
  }

  const live = componentTree();
  afterAll(() => rmSync(live, { recursive: true, force: true }));

  test("a .tsx test is collected, and the .tsx implementation is still excluded", () => {
    const sources = collectRedGateSources(live);
    expect(sources.testFiles).toEqual(["tests/badge.test.tsx"]);
    expect(sources.contracts).toEqual(["src/ui/badge.contract.ts"]);
    expect(sources.implementationFiles).toContain("src/ui/badge.tsx");
    expect(redGateProjectPlan(sources).copy).not.toContain("src/ui/badge.tsx");
  });

  test("the regenerated skeleton lands at .tsx, not beside the builder's file", () => {
    const shadow = materializeShadowProject(live, redGateProjectPlan(collectRedGateSources(live)));
    const skeleton = readFileSync(join(shadow, "src", "ui", "badge.tsx"), "utf8");
    expect(skeleton).toContain("GENERATED from badge.contract.ts");
    expect(skeleton).toContain('throw new NotImplementedError("Badge")');
    expect(skeleton).not.toContain("return null");
    expect(existsSync(join(shadow, "src", "ui", "badge.ts"))).toBe(false);
    expect(readFileSync(join(shadow, "tests", "badge.test.tsx"), "utf8")).toContain("component test");
  });
});

// --- Obligations: a valid red that covers nothing ---------------------------------
//
// Dogfood Run 7's suite was a right-reason red, type-clean, 32 tests — and it
// never called 9 of the contract's 15 exports. Both checks below would have
// blocked it, at the one moment when fixing it costs the test-writer 30 seconds.

function obligationsRepo(prefix: string, testSource: string, failures: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  writeFileSync(
    join(dir, "run.json"),
    vitestJson(failures.map((f, i) => ({ name: `t${i}`, status: "failed", message: `NotImplementedError: ${f}` }))),
  );
  writeFileSync(join(dir, "tsc.txt"), "");
  mkdirSync(join(dir, "src", "money"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "src", "money", "money.contract.ts"),
    CONTRACT + "\nexport declare function formatMoney(c: Currency): string;\n",
  );
  writeFileSync(join(dir, "tests", "money.test.ts"), testSource);
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
  return dir;
}

const BOUNDARIES_BLOCK = `import { describe, it, expect } from "vitest";
import { Currency } from "../src/money/money.js";
describe("Currency ${"\u2014"} boundaries", () => {
  it("accepts a well-formed code", () => { expect(Currency.parse("USD")).toBeDefined(); });
  it("rejects lowercase", () => { expect(Currency.parse("usd")).toBeUndefined(); });
  it("rejects two letters", () => { expect(Currency.parse("US")).toBeUndefined(); });
});
`;

describe("red-gate CLI: obligations", () => {
  test("an export no failure names is an export no test called", () => {
    // Currency is reached through its member; formatMoney is never called.
    // (Reachability is per EXPORT: a member throw discharges its owner.)
    const dir = obligationsRepo("red-unreached-", BOUNDARIES_BLOCK, ["Currency.parse"]);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/the red is valid but incomplete/);
    expect(r.stdout).toContain("red-gate: route → test-writer");
  });

  test("a value object with no boundaries block blocks the red", () => {
    const dir = obligationsRepo("red-noboundaries-", "// nothing\n", ["Currency.parse", "formatMoney"]);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/Currency/);
    expect(r.stdout).toContain("red-gate: route → test-writer");
  });

  test("one rejection is not two — the floor is two distinct wrong-value literals", () => {
    const oneRejection = BOUNDARIES_BLOCK.replace(
      '  it("rejects two letters", () => { expect(Currency.parse("US")).toBeUndefined(); });\n',
      "",
    );
    const dir = obligationsRepo("red-onereject-", oneRejection, ["Currency.parse", "formatMoney"]);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("red-gate: route → test-writer");
  });

  test("everything reached and the boundaries discharged → the red stands", () => {
    const dir = obligationsRepo("red-obliged-", BOUNDARIES_BLOCK, ["Currency.parse", "formatMoney"]);
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/red-gate: OK/);
  });
});

// A NotImplemented thrown at IMPORT time reads as a contradiction ("the right
// error is the wrong reason?") and cost Run 8's architect 25 minutes. The gate
// must say the throw happened during collection and name the fix.

describe("collection-time NotImplemented", () => {
  test("a file-level NotImplemented failure explains itself", () => {
    const r = classifyRed(
      run({ failed: 1, total: 1, results: [{ name: "(test file)", status: "failed", message: "NotImplemented: Currency.parse" }] }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(1);
    const out = r.lines.join("\n");
    expect(out).toMatch(/IMPORT\/COLLECTION/);
    expect(out).toMatch(/Move every such call inside a/);
  });

  test("an ordinary assertion failure gets no collection hint", () => {
    const r = classifyRed(
      run({ failed: 1, total: 1, results: [{ name: "adds", status: "failed", message: "expected 2 to be 3" }] }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).not.toMatch(/COLLECTION/);
  });
});

// Run 9 regression: an export whose inputs come from other exports can never
// surface in a red failure — every test dies at the first skeleton call. The
// gate jammed five bounces deep demanding a proof that was impossible by
// construction. Call sites in the test sources are the primary evidence now.

describe("red-gate CLI: downstream exports are reached by call site", () => {
  test("getInvoices called after applySubscriptionOperation is NOT unreached", () => {
    const dir = mkdtempSync(join(tmpdir(), "red-downstream-"));
    tmpDirs.push(dir);
    writeFileSync(
      join(dir, "run.json"),
      vitestJson([
        { name: "start", status: "failed", message: "NotImplementedError: NotImplemented: applySubscriptionOperation" },
      ]),
    );
    writeFileSync(join(dir, "tsc.txt"), "");
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(
      join(dir, "src", "billing.contract.ts"),
      [
        "export interface State { readonly n: number }",
        "export declare function applySubscriptionOperation(s: State | null): State;",
        "export declare function getInvoices(s: State): readonly number[];",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(dir, "tests", "billing.test.ts"),
      [
        'import { applySubscriptionOperation, getInvoices } from "../src/billing.js";',
        'describe("invoices", () => {',
        '  it("lists invoices", () => {',
        "    const s = applySubscriptionOperation(null);",
        "    expect(getInvoices(s)).toEqual([]);",
        "  });",
        "});",
      ].join("\n") + "\n",
    );
    writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/red-gate: OK/);
  });
});

// Run 10: kimi's test helpers used `!` freely because only src/** was linted.
// A suite that silences the type checker can assert its way past anything.

describe("red-gate CLI: escape hatches in test sources", () => {
  test("a non-null assertion in a test helper blocks an otherwise valid red", () => {
    const dir = fixtureRepo("red-testhatch-", vitestJson([{ name: "create order", status: "failed", message: NI }]));
    // The gate composes the hexagonal layout, so the tests lint walks the
    // composed source roots (lint-src.ts, `lintScope`): the helper is a
    // test-side file inside one.
    mkdirSync(join(dir, "contexts", "money", "src"), { recursive: true });
    writeFileSync(
      join(dir, "contexts", "money", "src", "helpers.test-support.ts"),
      "export function d(x: string | undefined): string { return x!; }\n",
    );
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/test sources switch the type checker off/);
    expect(r.stdout).toContain("no-non-null-assertion");
    expect(r.stdout).toContain("red-gate: route → test-writer");
  });

  test("generated laws are exempt — the generator answers for them", () => {
    const dir = fixtureRepo("red-genhatch-", vitestJson([{ name: "create order", status: "failed", message: NI }]));
    mkdirSync(join(dir, "tests", "generated"), { recursive: true });
    writeFileSync(join(dir, "tests", "generated", "x.laws.test.ts"), "export const n: number = 1 as number;\n");
    const r = runGate(dir);
    expect(r.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The shadow project: rebuilt every run, left behind for the postmortem
// ---------------------------------------------------------------------------

describe("the shadow is rebuilt from scratch on every run", () => {
  test("a poisoned shadow does not survive the next build", () => {
    const live = liveTree();
    const plan = redGateProjectPlan(collectRedGateSources(live));
    const shadow = materializeShadowProject(live, plan);

    // Poison it the way a stale shadow would be poisoned: a leftover test from
    // a previous ticket, and an implementation where a skeleton belongs.
    writeFileSync(join(shadow, "tests", "stale.test.ts"), "// from a previous run\n");
    writeFileSync(join(shadow, "src", "money", "money.ts"), "export class Currency { static parse() {} }\n");

    materializeShadowProject(live, plan);

    // Nothing carries over: a shadow that accumulates is a shadow that can go
    // stale, and a stale shadow is a verdict about a project that no longer exists.
    expect(existsSync(join(shadow, "tests", "stale.test.ts"))).toBe(false);
    expect(readFileSync(join(shadow, "src", "money", "money.ts"), "utf8")).toContain(
      'throw new NotImplementedError("Currency.parse")',
    );
    rmSync(live, { recursive: true, force: true });
  });

  test("the wipe unlinks the node_modules symlink, never the project's modules", () => {
    const live = liveTree();
    const modules = join(live, "node_modules", "vitest");
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, "marker.txt"), "the real dependency tree\n");

    const plan = redGateProjectPlan(collectRedGateSources(live));
    const shadow = materializeShadowProject(live, plan);
    expect(lstatSync(join(shadow, "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(shadow, "node_modules", "vitest", "marker.txt"))).toBe(true);

    materializeShadowProject(live, plan);
    // If the wipe followed the link instead of unlinking it, this file is gone
    // and the project can no longer run its own suite.
    expect(readFileSync(join(modules, "marker.txt"), "utf8")).toContain("the real dependency tree");
    rmSync(live, { recursive: true, force: true });
  });

  test("the shadow is left behind when the gate finishes — a deleted project cannot be inspected", () => {
    const dir = fixtureRepo("red-keeps-shadow-", vitestJson([{ name: "create order", status: "failed", message: NI }]));
    expect(runGate(dir).status).toBe(0);
    const shadow = shadowProjectDir(dir);
    expect(existsSync(join(shadow, "tests", "money.test.ts"))).toBe(true);
    expect(readFileSync(join(shadow, "src", "money", "money.ts"), "utf8")).toContain("NotImplementedError");
  });
});

// --- testsTreeHash ---------------------------------------------------------------
//
// The fingerprint green binds itself to. Red proves THESE tests can fail; once
// tests/ moves, the red is a claim about a suite that no longer exists.

describe("testsTreeHash", () => {
  function treeWithTests(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-tests-hash-"));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  }

  test("is stable across reads and identical for identical trees", () => {
    const a = treeWithTests({ "tests/money.test.ts": "a\n", "tests/generated/laws.test.ts": "b\n" });
    const b = treeWithTests({ "tests/money.test.ts": "a\n", "tests/generated/laws.test.ts": "b\n" });
    expect(testsTreeHash(a)).toBe(testsTreeHash(a));
    expect(testsTreeHash(a)).toBe(testsTreeHash(b));
    expect(testsTreeHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes when a test changes — that is the whole point", () => {
    const dir = treeWithTests({ "tests/money.test.ts": "expect(x).toBe(1);\n" });
    const before = testsTreeHash(dir);
    writeFileSync(join(dir, "tests", "money.test.ts"), "expect(x).toBe(2);\n");
    expect(testsTreeHash(dir)).not.toBe(before);
  });

  test("changes when a test is added, removed or renamed", () => {
    const dir = treeWithTests({ "tests/a.test.ts": "same\n" });
    const one = testsTreeHash(dir);
    writeFileSync(join(dir, "tests", "b.test.ts"), "more\n");
    const two = testsTreeHash(dir);
    expect(two).not.toBe(one);
    rmSync(join(dir, "tests", "b.test.ts"));
    expect(testsTreeHash(dir)).toBe(one);
    // A rename moves no bytes but changes what runs, so the path is hashed too.
    writeFileSync(join(dir, "tests", "renamed.test.ts"), "same\n");
    rmSync(join(dir, "tests", "a.test.ts"));
    expect(testsTreeHash(dir)).not.toBe(one);
  });

  test("covers fixtures, not just *.ts — a JSON the suite reads is part of what red proved", () => {
    const dir = treeWithTests({ "tests/a.test.ts": "x\n", "tests/fixtures/rates.json": '{"usd":1}\n' });
    const before = testsTreeHash(dir);
    writeFileSync(join(dir, "tests", "fixtures", "rates.json"), '{"usd":2}\n');
    expect(testsTreeHash(dir)).not.toBe(before);
  });

  test("CRLF churn is not an edit", () => {
    const lf = treeWithTests({ "tests/a.test.ts": "one\ntwo\n" });
    const crlf = treeWithTests({ "tests/a.test.ts": "one\r\ntwo\r\n" });
    expect(testsTreeHash(lf)).toBe(testsTreeHash(crlf));
  });

  test("the shadow project under .bounded cannot hash itself", () => {
    const dir = treeWithTests({ "tests/a.test.ts": "x\n" });
    const before = testsTreeHash(dir);
    mkdirSync(join(dir, ".bounded", "shadow-red", "tests"), { recursive: true });
    writeFileSync(join(dir, ".bounded", "shadow-red", "tests", "a.test.ts"), "x\n");
    expect(testsTreeHash(dir)).toBe(before);
  });

  test("a project with no tests/ hashes to the empty digest rather than throwing", () => {
    const dir = treeWithTests({ "src/a.ts": "x\n" });
    expect(testsTreeHash(dir)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// --- What the red records, so a later gate can bind to it -------------------------

describe("the red-gate event carries the inputs the verdict is about", () => {
  test("the contract manifest and the tests-tree hash", () => {
    const dir = fixtureRepo("red-inputs-", vitestJson([{ name: "create order", status: "failed", message: NI }]));
    expect(runGate(dir).status).toBe(0);
    const event = readGuardLog(dir).find((e) => e.guard === "red-gate")!;
    const detail = event.detail as { contractManifest?: Record<string, string>; testsTreeHash?: string; shadow?: string };
    expect(Object.keys(detail.contractManifest ?? {})).toEqual(["src/money/money.contract.ts"]);
    expect(detail.contractManifest!["src/money/money.contract.ts"]).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.testsTreeHash).toBe(testsTreeHash(dir));
    expect(detail.shadow).toBe(".bounded/shadow-red");
  });

  test("a blocked red records them too — a bounce is worth auditing as much as a pass", () => {
    const dir = fixtureRepo("red-inputs-block-", vitestJson([{ name: "math", status: "failed", message: "AssertionError: 1" }]));
    expect(runGate(dir).status).toBe(1);
    const detail = readGuardLog(dir).find((e) => e.guard === "red-gate")!.detail as { testsTreeHash?: string };
    expect(detail.testsTreeHash).toBe(testsTreeHash(dir));
  });
});

// ---------------------------------------------------------------------------
// The headline property: red stands against a FINISHED implementation
// ---------------------------------------------------------------------------
//
// The r13/r14 runs (kimi) died here. The builder had already implemented the
// contract when red was called, so no failure could be a NotImplementedError
// any more and the only way back to red was re-freezing the contracts to wipe
// src/. With the shadow project the question never arises — these run REAL
// vitest and REAL tsc against a project whose src/ is complete.

const REAL_VITEST = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "vitest");
const REAL_TSC = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsc");

/** A project the builder has ALREADY finished: real contract, real tests, real
 *  implementation, real node_modules (symlinked from the harness). */
function finishedProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"finished","type":"module","private":true}\n');
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      { compilerOptions: { strict: true, noEmit: true, target: "es2022", module: "esnext", moduleResolution: "bundler" } },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, "src", "calc.contract.ts"), "export declare function add(a: number, b: number): number;\n");
  // The builder, working in PARALLEL with the test-writer, is already done.
  writeFileSync(join(dir, "src", "calc.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  writeFileSync(
    join(dir, "tests", "calc.test.ts"),
    [
      'import { expect, test } from "vitest";',
      'import { add } from "../src/calc.js";',
      'test("adds", () => {',
      "  expect(add(2, 3)).toBe(5);",
      "});",
      "",
    ].join("\n"),
  );
  symlinkSync(join(import.meta.dirname, "..", "..", "..", "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
}

function runGateForReal(dir: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      BOUNDED_GATE_TEST_CMD: REAL_VITEST,
      BOUNDED_GATE_TEST_ARGS: JSON.stringify(["run", "--reporter=json"]),
      BOUNDED_GATE_TSC_CMD: REAL_TSC,
      BOUNDED_GATE_TSC_ARGS: JSON.stringify(["--noEmit", "--pretty", "false"]),
    },
  });
}

describe("red against a live tree the builder has already implemented", () => {
  test("the red stands, and the live src/ is never touched", { timeout: 120_000 }, () => {
    const dir = finishedProject("red-finished-");
    const r = runGateForReal(dir);
    expect(r.stdout + r.stderr).toMatch(/red-gate: OK — 1 NotImplemented failure/);
    expect(r.status).toBe(0);

    // The implementation is exactly where the builder left it …
    expect(readFileSync(join(dir, "src", "calc.ts"), "utf8")).toContain("return a + b;");
    // … and the skeleton the verdict was measured against lives in the shadow.
    const shadowImpl = readFileSync(join(shadowProjectDir(dir), "src", "calc.ts"), "utf8");
    expect(shadowImpl).toContain('throw new NotImplementedError("add")');
    expect(shadowImpl).not.toContain("return a + b;");
    // The shadow gets the tests verbatim and nothing else of the live src/.
    expect(readdirSync(join(shadowProjectDir(dir), "tests"))).toEqual(["calc.test.ts"]);
  });

  test("a wrong-reason failure is still caught in the shadow", { timeout: 120_000 }, () => {
    const dir = finishedProject("red-finished-wrong-");
    writeFileSync(
      join(dir, "tests", "wrong.test.ts"),
      ['import { expect, test } from "vitest";', 'test("bad arithmetic", () => {', "  expect(1).toBe(2);", "});", ""].join("\n"),
    );
    const r = runGateForReal(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/not caused by NotImplementedError \(wrong-reason red\)/);
    expect(r.stdout).toContain("red-gate: route → test-writer");
  });
});

// Existing fixtures exercise the previously installed language and web rules.
function mkdtempSync(prefix: string): string {
  const dir = createTempDir(prefix);
  writeProjectPacks(dir, ["ts", "ts-hexagonal", "ts-trpc", "ts-web"]);
  return dir;
}
