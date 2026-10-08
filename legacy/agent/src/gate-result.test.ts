import { describe, expect, test } from "vitest";
import {
  gateCodeOf,
  gateEnvelope,
  gateExitCode,
  gateRunning,
  gateVerdictOf,
  guardVerdictOf,
  resultLabel,
  resultVerdictLine,
  toGateResult,
  verdictLine,
  type GateResult,
} from "./gate-result.ts";

// The contract every host prints and parses (ADR LEG-2026-029). The verdict line
// used to live in the pi extension alone; its exact wording is what the
// architect reads, so it is pinned here rather than re-derived per host.

describe("codes and verdicts", () => {
  test("0, 1 and 2 map to PASS, BLOCK, ERROR in both vocabularies", () => {
    expect(gateVerdictOf(0)).toBe("PASS");
    expect(gateVerdictOf(1)).toBe("BLOCK");
    expect(gateVerdictOf(2)).toBe("ERROR");
    expect(guardVerdictOf(0)).toBe("pass");
    expect(guardVerdictOf(1)).toBe("block");
    expect(guardVerdictOf(2)).toBe("error");
  });

  test("any other exit code is 'the gate could not run'", () => {
    for (const code of [3, 64, 127, -1, Number.NaN]) {
      expect(gateCodeOf(code)).toBe(2);
      expect(gateVerdictOf(code)).toBe("ERROR");
    }
  });

  test("the verdict line reads exactly as the extension printed it", () => {
    expect(verdictLine("red-gate", 0)).toBe("red-gate: PASS");
    expect(verdictLine("red-gate", 1)).toBe("red-gate: BLOCK");
    expect(verdictLine("red-gate", 2)).toBe("red-gate: ERROR (misuse — the gate could not run)");
  });

  test("the exit code is the result's code", () => {
    const result: GateResult = { code: 1, verdict: "block", summary: "s", lines: [], detail: {} };
    expect(gateExitCode(result)).toBe(1);
  });
});

describe("toGateResult lifts a bare {code, lines} run onto the contract", () => {
  test("summary is the first line without the gate's own prefix", () => {
    const r = toGateResult("scaffold", { code: 0, lines: ["scaffold: 2 skeletons written", "  src/a.ts"] });
    expect(r).toMatchObject({ code: 0, verdict: "pass", summary: "2 skeletons written", detail: {} });
    expect(r.lines).toEqual(["scaffold: 2 skeletons written", "  src/a.ts"]);
  });

  test("a line without the prefix is quoted whole; no lines gives the label", () => {
    expect(toGateResult("x", { code: 1, lines: ["", "something failed"] }).summary).toBe("something failed");
    expect(toGateResult("x", { code: 2, lines: [] }).summary).toBe("ERROR");
  });

  test("clamps an out-of-contract code and carries the detail given", () => {
    const r = toGateResult("x", { code: 5, lines: ["x: boom"] }, { sites: 3 });
    expect(r.code).toBe(2);
    expect(r.verdict).toBe("error");
    expect(r.detail).toEqual({ sites: 3 });
  });
});

describe("gateEnvelope", () => {
  const base: GateResult = {
    code: 1,
    verdict: "block",
    summary: "2 errors",
    lines: ["typecheck: 2 errors", "typecheck: route → builder"],
    detail: { route: "builder", errorCount: 2 },
  };

  test("carries the result, the gate name, and the route lifted out of detail", () => {
    expect(gateEnvelope("typecheck", base)).toEqual({
      gate: "typecheck",
      verdict: "block",
      code: 1,
      summary: "2 errors",
      lines: base.lines,
      detail: base.detail,
      route: "builder",
    });
  });

  test("route is null when detail names none, or names it as something other than a string", () => {
    expect(gateEnvelope("x", { ...base, detail: {} }).route).toBeNull();
    expect(gateEnvelope("x", { ...base, detail: { route: 7 } }).route).toBeNull();
  });

  test("is plain JSON: a round trip loses nothing", () => {
    const env = gateEnvelope("typecheck", base);
    expect(JSON.parse(JSON.stringify(env))).toEqual(env);
  });
});

// RUNNING (ADR LEG-2026-073): only the harness's background runner answers it,
// through gateRunning; a runner's own 3 stays "the gate could not run".
describe("RUNNING", () => {
  test("only gateRunning builds RUNNING, and labels come from the result", () => {
    const running = gateRunning("deliver", { startedAt: "2026-10-05T10:00:00.000Z", job: "started", pid: 4242 });
    expect(running.code).toBe(3);
    expect(running.verdict).toBe("running");
    expect(resultVerdictLine("deliver", running).startsWith("deliver: RUNNING")).toBe(true);
    expect(resultVerdictLine("deliver", running)).toContain("call deliver again");
    expect(resultLabel(running)).toBe("RUNNING");
    expect(gateEnvelope("deliver", running).verdict).toBe("running");
    const block: GateResult = { code: 1, verdict: "block", summary: "s", lines: [], detail: {} };
    expect(resultVerdictLine("x", block)).toBe("x: BLOCK");
  });

  test("a bare runner still cannot claim RUNNING", () => {
    expect(gateCodeOf(3)).toBe(2);
    expect(toGateResult("x", { code: 3, lines: [] }).code).toBe(2);
  });
});
