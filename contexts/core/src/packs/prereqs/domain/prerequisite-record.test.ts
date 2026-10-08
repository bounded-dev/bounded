import { describe, expect, test } from "bun:test";
import { PrerequisiteRecord } from "./prerequisite-record.ts";
import { PrerequisiteStart } from "./prerequisite-start.ts";

const fingerprint = { sha256: "a".repeat(64), fileCount: 1 };
const record = { delegate: "plan-reviewer", unchangedSince: [".agent-state/*/plan.md"], fingerprint, callId: "toolu_1" };
const parsed = (raw: unknown): PrerequisiteRecord => {
  const result = PrerequisiteRecord.parse(raw);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const error = (raw: unknown): string => {
  const result = PrerequisiteRecord.parse(raw);
  return result.ok ? "accepted" : result.error;
};

describe("PrerequisiteRecord — a delegation that succeeded over unchanged files", () => {
  test("a record names the agent, its files, their fingerprint and the call that ran it", () => {
    const made = parsed(record);
    expect(made.delegate.value).toBe("plan-reviewer");
    expect(made.unchangedSince).toEqual([".agent-state/*/plan.md"]);
    expect(made.fingerprint.toJSON()).toEqual(fingerprint);
    expect(made.callId.value).toBe("toolu_1");
    expect<unknown>(made.toJSON()).toEqual(record);
    expect(Object.isFrozen(made)).toBe(true);
  });

  test("each refusal names its field", () => {
    for (const raw of [null, "x", { ...record, extra: 1 }, { delegate: "a", unchangedSince: ["x"], fingerprint }]) expect(error(raw)).toBe("A prerequisite record is { delegate, unchangedSince, fingerprint, callId }");
    expect(error({ ...record, delegate: "" })).toStartWith("A prerequisite record's delegate: ");
    expect(error({ ...record, unchangedSince: [] })).toBe("A prerequisite record's unchangedSince is a non-empty list of file patterns");
    expect(error({ ...record, unchangedSince: [".bounded/x"] })).toContain("is inside .bounded");
    expect(error({ ...record, fingerprint: { sha256: "a".repeat(64), fileCount: -2 } })).toBe("A prerequisite record's fingerprint: A file-set fingerprint's fileCount is a whole number of files, 0 or more");
    expect(error({ ...record, callId: "" })).toStartWith("A prerequisite record's callId: ");
  });

  test("the same agent and patterns, in any order, share a requirement key, with a start's too", () => {
    const one = parsed({ ...record, unchangedSince: ["spec.md", "src/**"] });
    expect(parsed({ ...record, unchangedSince: ["src/**", "spec.md"], callId: "toolu_2" }).requirementKey()).toBe(one.requirementKey());
    const start = PrerequisiteStart.parse({ delegate: "plan-reviewer", unchangedSince: ["src/**", "spec.md"], fingerprint });
    expect(start.ok && start.value.requirementKey()).toBe(one.requirementKey());
    expect(parsed({ ...record, unchangedSince: ["spec.md"] }).requirementKey()).not.toBe(one.requirementKey());
  });
});
