import { describe, expect, test } from "bun:test";
import { Effect } from "../events/effect.ts";
import { Verdict } from "../verdicts/verdict.ts";
import { AfterToolReport } from "./after-tool-report.ts";

const NOT_ONE = { ok: false, error: "it reported something that is not an after-tool report" };
const make = Effect.parse({ kind: "execute", command: "make" });

describe("AfterToolReport — what an after-tool check found", () => {
  test("a message and a record naming the effect, or neither", () => {
    expect(AfterToolReport.parse({ message: null, record: null })).toEqual({ ok: true, value: { message: null, record: null } });
    const parsed = AfterToolReport.parse({ message: "Restored", record: { verdict: Verdict.refuse("changed", "restore"), refusedBy: { effect: make.ok ? make.value : null }, note: "n" } });
    expect(parsed.ok && parsed.value.record?.refusedBy?.effect?.kind).toBe("execute");
    expect(parsed.ok && Object.isFrozen(parsed.value)).toBe(true);
  });

  test("refuses anything else, never throws", () => {
    for (const raw of [null, "done", { message: 5, record: null }, { message: null }, { message: null, record: { verdict: "x", refusedBy: null, note: "n" } }, { message: null, record: { verdict: Verdict.allow, refusedBy: { effect: "x" }, note: "n" } }]) {
      expect(AfterToolReport.parse(raw)).toEqual(NOT_ONE as never);
    }
    const hostile = new Proxy({}, { has: () => { throw new Error("trap"); } });
    expect(AfterToolReport.parse(hostile)).toEqual({ ok: false, error: "An after-tool report could not be read: trap" });
  });
});
