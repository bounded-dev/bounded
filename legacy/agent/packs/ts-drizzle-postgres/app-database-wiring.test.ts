// Issue #52 (ADR 2026-072): the app-database obligation is checked before the
// suite runs, at green and at deliver, and routes to the test-writer. A smoke
// test that would reach for a database it did not start never runs at all.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { logGuardEvent } from "../../src/guard-log.ts";
import type { PhaseTestDecision } from "../ts/pack.ts";
import { type CommandRun, runDeliver } from "../ts/scripts/deliver.ts";
import { runGreenGate } from "../ts/scripts/green-gate.ts";
import { cannedGateEnv, type CannedCase, withEnv } from "../ts/scripts/junit-fixture.test-support.ts";
import { combineDecisions } from "../ts/scripts/phase-policy.ts";
import { type Fixture, PIPELINE_PACKS, pipelineProject, placeStage, stageFiles } from "../ts/scripts/pipeline-fixture.test-support.ts";
import { testFilesHash } from "../ts/scripts/red-gate.ts";
import { runScaffold } from "../ts/scripts/scaffold-project.ts";

const SMOKE = "apps/web/src/server/composition-root.test.ts";
const fixtures: Fixture[] = [];
const temporary: string[] = [];
afterAll(() => {
  for (const f of fixtures) f.cleanup();
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** The notebook pipeline with Drizzle persistence, built, with a standing
 *  red; its smoke test calls `useAppDatabase()` only when `withCall`. */
function persisting(withCall: boolean): string {
  const f = pipelineProject(["design"], [...PIPELINE_PACKS, "ts-drizzle-postgres"]);
  fixtures.push(f);
  const scaffold = runScaffold(f.dir);
  expect(scaffold.code, scaffold.lines.join("\n")).toBe(0);
  for (const stage of ["tests", "tests-drizzle", "build", "build-drizzle"] as const) placeStage(f.dir, stage, f.scope);
  if (!withCall) writeFileSync(join(f.dir, SMOKE), stageFiles("tests", f.scope).get(SMOKE)!);
  logGuardEvent(f.dir, { guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (5 contract files)" });
  logGuardEvent(f.dir, { guard: "red-gate", verdict: "pass", summary: "RED OK", detail: { testFilesHash: testFilesHash(f.dir) } });
  return f.dir;
}

/** Green policies whose one service records that the suite was about to run. */
function suiteSpy(started: string[]) {
  const decision: PhaseTestDecision = {
    action: "run", unsetEnv: [],
    prepare: async () => { started.push("suite"); return { description: "suite spy", env: {}, release: () => {} }; },
  };
  return combineDecisions("green", [{ name: "suite-spy", decision }]);
}

const PASSING: readonly CannedCase[] = [
  { name: "Note > equals", status: "passed" },
  { name: "CreateNoteHandler > creates the note and saves it", status: "passed" },
];

describe("the app-database obligation runs before the suite (issue #52)", () => {
  test("green checks the app-database obligation before running the suite, routed to the test-writer", async () => {
    const dir = persisting(false);
    const started: string[] = [];
    const r = await withEnv(cannedGateEnv(dir, PASSING), () => runGreenGate(dir, { policy: suiteSpy(started) }));
    expect(r).toMatchObject({ code: 1, verdict: "block", detail: { reason: "obligations", route: "test-writer" } });
    expect(r.lines).toContain("green-gate: route → test-writer");
    expect((r.detail as { gaps: unknown[] }).gaps).toContainEqual(
      expect.objectContaining({ path: SMOKE, message: expect.stringContaining("useAppDatabase") }),
    );
    expect(started).toEqual([]);

    // With the call, the obligation is met and the suite runs.
    const ok = persisting(true);
    const passed = await withEnv(cannedGateEnv(ok, PASSING), () => runGreenGate(ok, { policy: suiteSpy(started) }));
    expect(passed.code, passed.lines.join("\n")).toBe(0);
    expect(started).toEqual(["suite"]);
  }, 120_000);

  test("deliver checks it before its check", async () => {
    const dir = persisting(false);
    const stub = join(mkdtempSync(join(tmpdir(), "wiring-stub-")), "surface-check.ts");
    temporary.push(dirname(stub));
    writeFileSync(stub, "// stub surface checker\n");
    const calls: string[][] = [];
    const run: CommandRun = (command, args, cwd) => {
      calls.push([command, ...args]);
      if (args[0] === "add") {
        mkdirSync(join(cwd, "node_modules", "ts-morph"), { recursive: true });
        writeFileSync(join(cwd, "node_modules", "ts-morph", "package.json"), '{"name":"ts-morph"}\n');
      }
      return { code: 0, stdout: "ok\n", stderr: "" };
    };
    const started: string[] = [];
    const r = await runDeliver(dir, { surfaceCheckSource: stub, run, policy: suiteSpy(started) });
    expect(r.code, r.lines.join("\n")).toBe(1);
    expect(r.lines).toContain("deliver: route → test-writer");
    expect(r.lines.join("\n")).toContain("useAppDatabase");
    expect(calls.some((call) => call[1] === "run" && call[2] === "check")).toBe(false);
    expect(started).toEqual([]);
  }, 120_000);
});
