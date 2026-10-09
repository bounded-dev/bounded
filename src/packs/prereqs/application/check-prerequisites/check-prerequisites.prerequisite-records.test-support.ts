import { describe, expect, test } from "bun:test";
import { CallId } from "bounded/domain";
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

/**
 * The behaviour every PrerequisiteRecords must have: records come back in the
 * order they were appended, as their wire forms; the starts kept for a call
 * come back once, as stored, and each call's are its own.
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
  });
}
