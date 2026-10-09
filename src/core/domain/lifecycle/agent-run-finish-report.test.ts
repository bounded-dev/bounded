import { describe, expect, test } from "bun:test";
import { Verdict } from "../verdicts/verdict.ts";
import { AgentRunFinishReport } from "./agent-run-finish-report.ts";

const NOT_ONE = { ok: false, error: "it reported something that is not an agent run finish report" };

describe("AgentRunFinishReport", () => {
  test("a finish check reports a record to write, or null", () => {
    const nothing = AgentRunFinishReport.parse({ record: null });
    expect(nothing).toEqual({ ok: true, value: { record: null } });
    expect(nothing.ok && Object.isFrozen(nothing.value)).toBe(true);
    const allowed = AgentRunFinishReport.parse({ record: { verdict: Verdict.allow, note: "recorded" } });
    expect(allowed.ok && allowed.value.record?.verdict.kind).toBe("allow");
    expect(allowed.ok && allowed.value.record?.note).toBe("recorded");
    expect(allowed.ok && Object.isFrozen(allowed.value) && Object.isFrozen(allowed.value.record)).toBe(true);
    const refused = AgentRunFinishReport.parse({ record: { verdict: Verdict.refuse("changed while it ran", "run it again"), note: "not recorded" } });
    expect(refused.ok && refused.value.record?.verdict.kind).toBe("refuse");
    for (const raw of [null, {}, { record: { verdict: Verdict.allow } }, { record: { verdict: "allow", note: "n" } }, { message: "told", record: null }]) {
      expect(AgentRunFinishReport.parse(raw)).toEqual(NOT_ONE as never);
    }
  });

  test("never throws", () => {
    const hostile = new Proxy({}, { has: () => { throw new Error("trap"); }, ownKeys: () => { throw new Error("trap"); } });
    expect(AgentRunFinishReport.parse(hostile)).toEqual({ ok: false, error: "An agent run finish report could not be read: trap" });
  });
});
