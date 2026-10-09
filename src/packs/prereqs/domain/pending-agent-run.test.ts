import { describe, expect, test } from "bun:test";
import { PendingAgentRun } from "./pending-agent-run.ts";

const fingerprint = { sha256: "a".repeat(64), fileCount: 1 };
const start = { delegate: "plan-reviewer", unchangedSince: [".agent-state/*/plan.md"], fingerprint };
const pending = { agentRunId: "a6eef1505a0b443a2", callId: "toolu_1", startedAt: "2026-10-09T12:00:00.000Z", starts: [start] };
const error = (raw: unknown): string => {
  const parsed = PendingAgentRun.parse(raw);
  return parsed.ok ? "accepted" : parsed.error;
};

describe("PendingAgentRun", () => {
  test("a pending run names its run, the call that started it, when it was seen to start, and the starts it carries", () => {
    const parsed = PendingAgentRun.parse(pending);
    expect<unknown>(parsed.ok && parsed.value.toJSON()).toEqual(pending);
    expect(parsed.ok && parsed.value.agentRunId.value).toBe("a6eef1505a0b443a2");
    expect(parsed.ok && parsed.value.callId.value).toBe("toolu_1");
    expect(parsed.ok && parsed.value.startedAt.value).toBe("2026-10-09T12:00:00.000Z");
    expect(parsed.ok && parsed.value.starts.map((kept) => kept.delegate.value)).toEqual(["plan-reviewer"]);
    expect(parsed.ok && Object.isFrozen(parsed.value) && Object.isFrozen(parsed.value.starts)).toBe(true);
    expect(PendingAgentRun.parse(JSON.parse(JSON.stringify(parsed.ok ? parsed.value : null))).ok).toBe(true);
  });

  test("each refusal names its field", () => {
    for (const raw of [null, [], "a1", { ...pending, extra: 1 }, { agentRunId: "a1", callId: "c1", startedAt: pending.startedAt }]) expect(error(raw)).toBe("A pending agent run is { agentRunId, callId, startedAt, starts }");
    expect(error({ ...pending, agentRunId: "" })).toBe("A pending agent run's agentRunId: An agent run id is non-empty text without control characters, at most 256 characters");
    expect(error({ ...pending, callId: "" })).toBe("A pending agent run's callId: A tool call id is non-empty text without control characters, at most 256 characters");
    expect(error({ ...pending, startedAt: "yesterday" })).toStartWith("A pending agent run's startedAt: A decision time is ISO 8601 in UTC");
    expect(error({ ...pending, starts: [] })).toBe("A pending agent run's starts are a non-empty list of prerequisite starts");
    expect(error({ ...pending, starts: "x" })).toBe("A pending agent run's starts are a non-empty list of prerequisite starts");
    expect(error({ ...pending, starts: [{ ...start, delegate: " " }] })).toStartWith("A pending agent run's starts: A prerequisite start's delegate: ");
  });

  test("never throws", () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("trap"); }, get: () => { throw new Error("trap"); } });
    expect(error(hostile)).toBe("A pending agent run could not be read: trap");
  });
});
