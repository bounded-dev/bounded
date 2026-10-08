import { describe, expect, test } from "bun:test";
import { AdapterRefusal } from "./adapter-refusal.ts";

const parsed = (raw: unknown): AdapterRefusal => {
  const result = AdapterRefusal.parse(raw);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("AdapterRefusal — boundaries", () => {
  test("a refusal the host made: its tool name, the call's input, the role, and the reason and redirect", () => {
    const refusal = parsed({ hostToolName: "Bash", reason: "outside the project", redirect: "Stay inside", role: "builder", input: { command: "cat /etc/passwd" } });
    expect([refusal.hostToolName, refusal.role, refusal.input]).toEqual(["Bash", "builder", { command: "cat /etc/passwd" }]);
    expect(refusal.verdict.toJSON()).toEqual({ kind: "refuse", reason: "outside the project", redirect: "Stay inside" });
  });

  test("is read leniently, since it must be recorded whatever form it came in", () => {
    const refusal = parsed({ hostToolName: 7, reason: "", role: 3 });
    expect(refusal.hostToolName).toBe("7");
    expect(refusal.role).toBeNull();
    expect(refusal.verdict.toJSON()).toEqual({ kind: "refuse", reason: "The action was refused without a reason", redirect: "Ask the maintainer of the refusing guard for the permitted next step" });
    expect(parsed({}).hostToolName).toBe("unknown");
  });

  test("refuses what is not an object, and what cannot be read, never throws", () => {
    expect(AdapterRefusal.parse(null)).toEqual({ ok: false, error: "An adapter refusal is an object: { hostToolName, reason, redirect, role?, input? }" });
    const hostile = { hostToolName: "Bash", reason: { toString: () => { throw new Error("trap"); } } };
    expect(AdapterRefusal.parse(hostile)).toEqual({ ok: false, error: "An adapter refusal could not be read: trap" });
  });
});
