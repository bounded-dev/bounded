import { describe, expect, test } from "bun:test";
import { AgentRunId, CallId, DecisionTime } from "bounded/domain";
import { PrerequisiteRecord } from "../../domain/prerequisite-record.ts";
import { PrerequisiteStart } from "../../domain/prerequisite-start.ts";
import type { PrerequisiteRecords } from "./check-prerequisites.contract.ts";

const fingerprint = { sha256: "a".repeat(64), fileCount: 1 };

/** A record from its wire form; a test failure when it is not one. */
export function recordOf(delegate: string, callId: string, unchangedSince: readonly string[] = ["plans/plan.md"]): PrerequisiteRecord {
  const parsed = PrerequisiteRecord.parse({ delegate, unchangedSince, fingerprint, callId });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** A start from its wire form; a test failure when it is not one. */
export function startOf(delegate: string, unchangedSince: readonly string[] = ["plans/plan.md"]): PrerequisiteStart {
  const parsed = PrerequisiteStart.parse({ delegate, unchangedSince, fingerprint });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** A call id; a test failure when it is not one. */
export function callIdOf(raw: string): CallId {
  const parsed = CallId.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** An agent run id; a test failure when it is not one. */
export function agentRunIdOf(raw: string): AgentRunId {
  const parsed = AgentRunId.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** Whether `raw` is a time as the store stamps it: ISO 8601 in UTC. */
const isTime = (raw: unknown): boolean => DecisionTime.parse(raw).ok;

/**
 * The behaviour every PrerequisiteRecords must have: records come back in the
 * order they were appended, as their wire forms; the starts kept for a call
 * come back once, as stored, and each call's are its own; the starts kept for
 * a run come back once, with when they were kept, are listed while kept, and
 * are apart from any call's.
 */
export function prerequisiteRecordsConformance(name: string, fixture: () => Promise<PrerequisiteRecords>): void {
  describe(`${name} conforms to PrerequisiteRecords`, () => {
    test("a new store has no records", async () => {
      expect(await (await fixture()).readAll()).toEqual([]);
    });

    test("appended records come back in order, as their wire forms", async () => {
      const records = await fixture();
      const appended = [recordOf("plan-reviewer", "c1"), recordOf("spec-reviewer", "c2", ["spec.md"]), recordOf("plan-reviewer", "c3")];
      for (const record of appended) await records.append(record);
      expect(await records.readAll()).toEqual(appended.map((record) => record.toJSON()));
    });

    test("a call's starts come back as stored, and are removed when taken", async () => {
      const records = await fixture();
      const starts = [startOf("plan-reviewer"), startOf("spec-reviewer", ["spec.md", "src/**"])];
      await records.saveStartedForCall(callIdOf("call/1:x"), starts);
      expect(await records.takeStartedForCall(callIdOf("call/1:x"))).toEqual(starts.map((start) => start.toJSON()));
      expect(await records.takeStartedForCall(callIdOf("call/1:x"))).toBeUndefined();
    });

    test("a call it never saw has no starts", async () => {
      expect(await (await fixture()).takeStartedForCall(callIdOf("never"))).toBeUndefined();
    });

    test("two calls' starts are independent", async () => {
      const records = await fixture();
      await records.saveStartedForCall(callIdOf("a"), [startOf("plan-reviewer")]);
      await records.saveStartedForCall(callIdOf("b"), [startOf("spec-reviewer")]);
      expect(await records.takeStartedForCall(callIdOf("b"))).toEqual([startOf("spec-reviewer").toJSON()]);
      expect(await records.takeStartedForCall(callIdOf("a"))).toEqual([startOf("plan-reviewer").toJSON()]);
    });

    test("saving a call's starts again replaces them", async () => {
      const records = await fixture();
      await records.saveStartedForCall(callIdOf("a"), [startOf("plan-reviewer")]);
      await records.saveStartedForCall(callIdOf("a"), [startOf("spec-reviewer")]);
      expect(await records.takeStartedForCall(callIdOf("a"))).toEqual([startOf("spec-reviewer").toJSON()]);
    });

    test("a run's start comes back as kept, with when it was kept, and is removed when taken", async () => {
      const records = await fixture();
      const starts = [startOf("plan-reviewer"), startOf("spec-reviewer", ["spec.md"])];
      await records.saveStartedForRun(agentRunIdOf("a1"), callIdOf("c1"), starts);
      const taken = await records.takeStartedForRun(agentRunIdOf("a1"));
      expect(taken).toMatchObject({ agentRunId: "a1", callId: "c1", starts: starts.map((start) => start.toJSON()) });
      expect(isTime((taken as { startedAt?: unknown }).startedAt)).toBe(true);
      expect(await records.takeStartedForRun(agentRunIdOf("a1"))).toBeUndefined();
    });

    test("a run it never saw has no start", async () => {
      expect(await (await fixture()).takeStartedForRun(agentRunIdOf("never"))).toBeUndefined();
    });

    test("the runs' starts are listed while kept, and listing removes none", async () => {
      const records = await fixture();
      expect(await records.readStartedForRuns()).toEqual([]);
      await records.saveStartedForRun(agentRunIdOf("a1"), callIdOf("c1"), [startOf("plan-reviewer")]);
      await records.saveStartedForRun(agentRunIdOf("a2"), callIdOf("c2"), [startOf("spec-reviewer")]);
      const listed = await records.readStartedForRuns();
      expect(listed.map((run) => (run as { agentRunId: string }).agentRunId).sort()).toEqual(["a1", "a2"]);
      expect(await records.readStartedForRuns()).toHaveLength(2);
      expect(await records.takeStartedForRun(agentRunIdOf("a1"))).toMatchObject({ agentRunId: "a1", callId: "c1" });
      expect((await records.readStartedForRuns()).map((run) => (run as { agentRunId: string }).agentRunId)).toEqual(["a2"]);
    });

    test("a run's start and a call's start with the same id are apart", async () => {
      const records = await fixture();
      await records.saveStartedForCall(callIdOf("x1"), [startOf("plan-reviewer")]);
      await records.saveStartedForRun(agentRunIdOf("x1"), callIdOf("c1"), [startOf("spec-reviewer")]);
      expect(await records.takeStartedForCall(callIdOf("x1"))).toEqual([startOf("plan-reviewer").toJSON()]);
      expect(await records.takeStartedForRun(agentRunIdOf("x1"))).toMatchObject({ starts: [startOf("spec-reviewer").toJSON()] });
    });

    test("saving a run's start again replaces it", async () => {
      const records = await fixture();
      await records.saveStartedForRun(agentRunIdOf("a1"), callIdOf("c1"), [startOf("plan-reviewer")]);
      await records.saveStartedForRun(agentRunIdOf("a1"), callIdOf("c2"), [startOf("spec-reviewer")]);
      expect(await records.readStartedForRuns()).toHaveLength(1);
      expect(await records.takeStartedForRun(agentRunIdOf("a1"))).toMatchObject({ callId: "c2", starts: [startOf("spec-reviewer").toJSON()] });
    });
  });
}
