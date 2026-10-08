import { afterAll, describe, expect, test } from "vitest";
import { readGuardLog } from "../../../src/guard-log.ts";
import { makeTempProject, type TempProject } from "../../../test/support/temp-project.ts";
import { parseRole, typecheckGate } from "./typecheck-gate.ts";
import type { CommandRunner } from "./typecheck.ts";

// The boundary that joins typecheck.ts (runs tsc) and typecheck-scope.ts
// (narrows by role) and writes the guard event — the semantics the
// `typecheck` worker tool had, now reachable by any host (ADR LEG-2026-029).

const projects: TempProject[] = [];
afterAll(() => projects.forEach((p) => p.cleanup()));

function project(): string {
  const p = makeTempProject({}, { prefix: "typecheck-gate-", packs: ["ts", "ts-hexagonal"] });
  projects.push(p);
  return p.dir;
}

/** A tsc stand-in that replays captured diagnostics with tsc's exit code. */
function fakeTsc(stdout: string, code: number): CommandRunner {
  return async () => ({ stdout, stderr: "", code });
}

const SRC_ERR = "contexts/pm/src/domain/a.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.";
const TEST_ERR = "contexts/pm/src/domain/a.test.ts(5,3): error TS2304: Cannot find name 'Secret'.";

describe("typecheckGate", () => {
  test("clean project: PASS, one guard event saying so", async () => {
    const dir = project();
    const r = await typecheckGate(dir, undefined, { run: fakeTsc("", 0) });
    expect(r).toMatchObject({ code: 0, verdict: "pass", summary: "no type errors" });
    expect(r.lines).toEqual(["typecheck: OK — no type errors"]);
    expect(r.detail).toEqual({ ok: true, errorCount: 0 });
    expect(readGuardLog(dir)).toEqual([
      expect.objectContaining({ guard: "typecheck", verdict: "pass", summary: "no type errors" }),
    ]);
  });

  test("unscoped: BLOCK with every diagnostic shown", async () => {
    const dir = project();
    const r = await typecheckGate(dir, undefined, { run: fakeTsc(`${SRC_ERR}\n${TEST_ERR}`, 2) });
    expect(r).toMatchObject({ code: 1, verdict: "block", summary: "2 errors" });
    expect(r.lines.join("\n")).toContain(SRC_ERR);
    expect(r.lines.join("\n")).toContain(TEST_ERR);
    expect(r.detail).toEqual({ ok: false, errorCount: 2 });
  });

  // The summary in the log is the WHOLE project's verdict even when the
  // caller's view is scoped: the log is the orchestrator's evidence.
  test("scoped to the builder: the test-file error is a count, never its text", async () => {
    const dir = project();
    const r = await typecheckGate(dir, "builder", { run: fakeTsc(`${SRC_ERR}\n${TEST_ERR}`, 2) });
    expect(r.code).toBe(1);
    const text = r.lines.join("\n");
    expect(text).toContain(SRC_ERR);
    expect(text).not.toContain("Secret");
    expect(text).not.toContain("a.test.ts");
    expect(text).toMatch(/1 further error in another role's zone \(test-writer's\)/);
    expect(r.detail).toEqual({ ok: false, errorCount: 1, scoped: true, hidden: 1 });
    const [event] = readGuardLog(dir);
    expect(event).toMatchObject({
      guard: "typecheck",
      verdict: "block",
      summary: "2 errors",
      detail: { role: "builder", scoped: true, shown: 1, hidden: 1, hiddenOwner: "test-writer" },
    });
  });

  test("the architect's view is never scoped", async () => {
    const dir = project();
    const r = await typecheckGate(dir, "architect", { run: fakeTsc(TEST_ERR, 2) });
    expect(r.lines.join("\n")).toContain(TEST_ERR);
    expect(r.detail).toEqual({ ok: false, errorCount: 1 });
  });
});

describe("parseRole", () => {
  test("the four pipeline roles, and nothing else", () => {
    for (const role of ["architect", "test-writer", "builder", "reviewer"]) expect(parseRole(role)).toBe(role);
    expect(parseRole("orchestrator")).toBeUndefined();
    expect(parseRole(undefined)).toBeUndefined();
  });
});
