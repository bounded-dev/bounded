import type { CallId } from "bounded/domain";
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
}
