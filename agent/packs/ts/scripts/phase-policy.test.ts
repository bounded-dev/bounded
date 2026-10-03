import { describe, expect, test } from "vitest";
import { isSkippedStoreTest, storeTestPhaseDecision, storeTestPolicy } from "../../ts-drizzle-postgres/scripts/container-runtime.ts";
import type { PhaseTestDecision } from "../pack.ts";
import { combineDecisions } from "./phase-policy.ts";

const SKIP: PhaseTestDecision = {
  action: "skip", reason: "2 store test file(s) skipped at red: no runtime",
  env: { BOUNDED_STORE_TESTS_SKIP: "x", BOUNDED_STORE_TESTS_PHASE: "red" },
  unsetEnv: ["BOUNDED_STORE_TESTS_SKIP", "BOUNDED_STORE_TESTS_PHASE"],
  skippedTest: (name) => name.startsWith("Drizzle"),
};

describe("combining the composed phase test policies", () => {
  test("no policy: run, change nothing, claim no skip", () => {
    const run = combineDecisions("red", []);
    expect(run).toMatchObject({ refusals: [], skips: [], env: { set: {}, unset: [] } });
    expect(run.skippedOnPurpose("anything")).toBe(false);
  });

  test("a red skip sets its variables in the test process and claims only its own results", () => {
    const run = combineDecisions("red", [{ name: "store", decision: SKIP }]);
    expect(run.env).toEqual({ set: SKIP.env, unset: [] });
    expect(run.skips).toEqual([SKIP.reason]);
    expect(run.skippedOnPurpose("DrizzleCreateNoteStore > saves")).toBe(true);
    expect(run.skippedOnPurpose("Note > equals")).toBe(false);
  });

  test("a run removes the variables a leftover could skip with", () => {
    const run = combineDecisions("green", [{ name: "store", decision: { action: "run", unsetEnv: ["A", "B"] } }]);
    expect(run).toMatchObject({ refusals: [], env: { set: {}, unset: ["A", "B"] } });
  });

  test("a refusal refuses; a skip at green is read as a refusal, never a skip", () => {
    const refuse = combineDecisions("green", [{ name: "store", decision: { action: "refuse", reason: "no runtime", unsetEnv: ["A"] } }]);
    expect(refuse.refusals).toEqual(["no runtime"]);
    const skipAtGreen = combineDecisions("green", [{ name: "store", decision: SKIP }]);
    expect(skipAtGreen.refusals).toEqual([`store asked to skip tests at green: ${SKIP.reason}`]);
    expect(skipAtGreen.env.set).toEqual({});
  });
});

describe("the store-test policy (ts-drizzle-postgres, ADR 2026-064)", () => {
  const absent = () => ({ available: false as const, reason: "no container runtime found" });
  const present = () => ({ available: true as const, endpoint: "unix:///var/run/docker.sock" });

  test("no store tests: run, and the runtime is never probed", () => {
    let probed = false;
    const decision = storeTestPhaseDecision("green", [], () => { probed = true; return absent(); });
    expect(decision.action).toBe("run");
    expect(probed).toBe(false);
  });

  test("store tests and no runtime: red skips with the reason, green refuses", () => {
    const tests = ["contexts/a/src/adapters/out/drizzle/x/y.store.test.ts"];
    const red = storeTestPhaseDecision("red", tests, absent);
    expect(red).toMatchObject({ action: "skip", env: { BOUNDED_STORE_TESTS_PHASE: "red" } });
    expect(red.action === "skip" && red.reason).toMatch(/1 Drizzle store test file\(s\) skipped at red: no container runtime found/);
    const green = storeTestPhaseDecision("green", tests, absent);
    expect(green).toMatchObject({ action: "refuse" });
    expect(green.action === "refuse" && green.reason).toMatch(/green needs a container runtime/);
  });

  test("with a runtime red still skips (no migrations yet) and green runs", () => {
    const tests = ["contexts/a/src/adapters/out/drizzle/x/y.store.test.ts"];
    expect(storeTestPhaseDecision("red", tests, present).action).toBe("skip");
    expect(storeTestPhaseDecision("green", tests, present).action).toBe("run");
  });

  test("a red skip claims only the Drizzle store blocks", () => {
    expect(isSkippedStoreTest("DrizzleCreateNoteStore > DrizzleCreateNoteStore conforms to CreateNoteStore > saves")).toBe(true);
    expect(isSkippedStoreTest("InMemoryCreateNoteStore > saves")).toBe(false);
    expect(isSkippedStoreTest("Drizzle > not a store")).toBe(false);
    expect(storeTestPolicy.name).toBe("store-tests-need-a-container-runtime");
  });
});

describe("the builder's run (the build phase, issue #48)", () => {
  const A: PhaseTestDecision = { action: "run", unsetEnv: [], exclude: { files: ["contexts/a/src/a.store.test.ts"], reason: "no container runtime" } };
  const B: PhaseTestDecision = { action: "run", unsetEnv: [], exclude: { files: ["apps/web/src/composition-root.test.ts"], reason: "no migrations yet" } };
  const decisions = [{ name: "first-policy", decision: A }, { name: "second-policy", decision: B }];

  test("exclusions are merged at build and are a refusal at red and green", () => {
    const build = combineDecisions("build", decisions);
    expect(build.refusals).toEqual([]);
    expect(build.exclusions.files).toEqual(["contexts/a/src/a.store.test.ts", "apps/web/src/composition-root.test.ts"]);
    expect(build.exclusions.reasons).toEqual(["no container runtime", "no migrations yet"]);
    for (const phase of ["red", "green"] as const) {
      const run = combineDecisions(phase, decisions);
      expect(run.refusals, phase).toHaveLength(2);
      expect(run.refusals[0], phase).toContain("first-policy");
      expect(run.refusals[1], phase).toContain("second-policy");
      expect(run.exclusions.files, phase).toEqual([]);
    }
  });
});
