import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { classifySignOff, hasPassingGreen, parseFindings, runSignOff } from "./sign-off.ts";
import { logGuardEvent, readGuardLog } from "../../../src/guard-log.ts";

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(withGreen: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-signoff-"));
  tmpDirs.push(dir);
  if (withGreen) {
    logGuardEvent(dir, { guard: "green-gate", verdict: "pass", summary: "GREEN (32/32 passed, typecheck clean)" });
  }
  return dir;
}

describe("parseFindings", () => {
  test("an empty list is a valid answer — saying 'nothing' is the point", () => {
    const r = parseFindings([]);
    expect(r).toEqual({ ok: true, findings: [] });
  });

  test("a finding needs a severity and a non-empty summary", () => {
    expect(parseFindings([{ severity: "note" }])).toMatchObject({ ok: false });
    expect(parseFindings([{ severity: "note", summary: "   " }])).toMatchObject({ ok: false });
    expect(parseFindings([{ severity: "urgent", summary: "x" }])).toMatchObject({ ok: false });
  });

  // Issue #48: two malformed payloads in a row, each error naming only the
  // field that failed. Every error now shows the whole shape.
  test("every payload error shows the shape of a finding", () => {
    for (const raw of [["x"], [{ severity: "high", summary: "s" }], [{ severity: "note" }]]) {
      const r = parseFindings(raw);
      expect(r.ok, JSON.stringify(raw)).toBe(false);
      if (r.ok) continue;
      expect(r.error).toContain('"severity"');
      expect(r.error).toContain("blocker | concern | note");
      expect(r.error).toContain('"summary"');
    }
  });

  test("rejects a non-array and says what to pass instead", () => {
    const r = parseFindings(undefined);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/pass \[\]/);
  });

  test("keeps evidence when given", () => {
    const r = parseFindings([{ severity: "blocker", summary: "non-null assertion lies", evidence: "src/x.ts:197" }]);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.findings[0]?.evidence).toBe("src/x.ts:197");
  });
});

describe("hasPassingGreen", () => {
  test("only a PASSING green counts", () => {
    expect(hasPassingGreen([{ guard: "green-gate", verdict: "pass" }])).toBe(true);
    expect(hasPassingGreen([{ guard: "green-gate", verdict: "block" }])).toBe(false);
    expect(hasPassingGreen([{ guard: "red-gate", verdict: "pass" }])).toBe(false);
  });
});

describe("classifySignOff", () => {
  test("refuses sign-off with no green to sign off on", () => {
    const r = classifySignOff([], false);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/nothing to sign off on/);
  });

  test("records a clean sign-off", () => {
    const r = classifySignOff([], true);
    expect(r.code).toBe(0);
    expect(r.summary).toBe("signed off, no findings");
  });

  test("a blocker is recorded and the architect is told not to report a clean green", () => {
    const r = classifySignOff(
      [{ severity: "blocker", summary: "replay returns an undefined invoice", evidence: "src/billing.ts:197" }],
      true,
    );
    expect(r.code).toBe(0);
    expect(r.summary).toMatch(/1 finding \(1 blocker\)/);
    expect(r.lines.join("\n")).toMatch(/blocker: replay returns an undefined invoice — src\/billing\.ts:197/);
    expect(r.lines.join("\n")).toMatch(/rather than reporting a clean green/);
  });

  test("the gate never judges a finding — it records the claim", () => {
    const r = classifySignOff([{ severity: "note", summary: "anything at all" }], true);
    expect(r.verdict).toBe("pass");
  });
});

describe("runSignOff (guard log)", () => {
  test("a refusal is logged as loudly as a pass", () => {
    const dir = repo(false);
    const r = runSignOff(dir, []);
    expect(r.code).toBe(1);
    const log = readGuardLog(dir);
    expect(log.at(-1)).toMatchObject({ guard: "sign-off", verdict: "block" });
  });

  test("findings survive into the guard log, so a later run can grade them", () => {
    const dir = repo(true);
    const r = runSignOff(dir, [{ severity: "concern", summary: "9 exports untested" }]);
    expect(r.code).toBe(0);
    const last = readGuardLog(dir).at(-1);
    expect(last).toMatchObject({ guard: "sign-off", verdict: "pass" });
    expect(JSON.stringify(last?.detail)).toContain("9 exports untested");
  });

  test("a malformed payload is misuse, not a refusal", () => {
    const dir = repo(true);
    expect(runSignOff(dir, "nope").code).toBe(2);
  });
});
