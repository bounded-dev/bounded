import type { AgentRunId, CallId } from "bounded/domain";
import type { PrerequisiteRecord, PrerequisiteRecords, PrerequisiteStart } from "./check-prerequisites.contract.ts";

/** A value as another process would read it back: its JSON, parsed. */
const stored = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** Records and starts in memory: a test double of PrerequisiteRecords, for tests only (ADR 2026-017). */
export class InMemoryPrerequisiteRecords implements PrerequisiteRecords {
  /** Every record as stored. */
  readonly records: unknown[] = [];
  /** The starts kept for each call id, as stored; a test may replace them, as anything running as the user could. */
  readonly startedByCall = new Map<string, unknown>();
  /** When set, readAll rejects with it. */
  readFailure: string | undefined;
  /** When set, append rejects with it. */
  appendFailure: string | undefined;
  /** The pending entry kept for each run id, as stored; a test may replace it, as anything running as the user could. */
  readonly startedByRun = new Map<string, unknown>();
  /** When a run's start is kept, as the store stamps it. */
  now = "2026-10-09T12:00:00.000Z";
  /** When set, saveStartedForRun rejects with it. */
  runSaveFailure: string | undefined;
  /** When set, takeStartedForRun rejects with it. */
  runTakeFailure: string | undefined;
  /** When set, readStartedForRuns rejects with it. */
  runReadFailure: string | undefined;
  /** How many times any method was called. */
  calls = 0;

  async append(record: PrerequisiteRecord): Promise<void> {
    this.calls++;
    if (this.appendFailure !== undefined) throw new Error(this.appendFailure);
    this.records.push(stored(record));
  }

  async readAll(): Promise<readonly unknown[]> {
    this.calls++;
    if (this.readFailure !== undefined) throw new Error(this.readFailure);
    return [...this.records];
  }

  async saveStartedForCall(callId: CallId, starts: readonly PrerequisiteStart[]): Promise<void> {
    this.calls++;
    this.startedByCall.set(callId.value, stored(starts));
  }

  async takeStartedForCall(callId: CallId): Promise<unknown> {
    this.calls++;
    const starts = this.startedByCall.get(callId.value);
    this.startedByCall.delete(callId.value);
    return starts;
  }

  async saveStartedForRun(agentRunId: AgentRunId, callId: CallId, starts: readonly PrerequisiteStart[]): Promise<void> {
    this.calls++;
    if (this.runSaveFailure !== undefined) throw new Error(this.runSaveFailure);
    this.startedByRun.set(agentRunId.value, stored({ agentRunId, callId, startedAt: this.now, starts }));
  }

  async takeStartedForRun(agentRunId: AgentRunId): Promise<unknown> {
    this.calls++;
    if (this.runTakeFailure !== undefined) throw new Error(this.runTakeFailure);
    const pending = this.startedByRun.get(agentRunId.value);
    this.startedByRun.delete(agentRunId.value);
    return pending;
  }

  async readStartedForRuns(): Promise<readonly unknown[]> {
    this.calls++;
    if (this.runReadFailure !== undefined) throw new Error(this.runReadFailure);
    return [...this.startedByRun.values()];
  }
}
