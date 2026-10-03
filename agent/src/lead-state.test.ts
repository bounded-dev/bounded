import { describe, expect, test } from "vitest";
import {
  ARCHITECT_ENDED, backgroundWorkers, LEAD_GUARD, SEAT_RELEASED, SUBAGENT_STOPPED, WORKER_CONTINUING, WORKER_RESUMED, WORKER_SEND_FAILED,
} from "./lead-state.ts";
import type { ProcessProbe } from "./process-lock.ts";

// The background-worker hold (ADR 2026-066) fails closed: it ends only with
// the worker's recorded stop, its session gone stale, or the user's release.

const T0 = Date.parse("2026-10-03T08:00:00.000Z");
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const live: ProcessProbe = { startTime: (pid) => (pid === 10 ? "t" : undefined) };
const resumed = (worker: string, s: number, pid = 10) => ({ guard: "phase-gate", ts: at(s), detail: { kind: WORKER_RESUMED, worker, pid, pidStarted: "t" } });
const continuing = (worker: string, s: number) => ({ guard: "phase-gate", ts: at(s), detail: { kind: WORKER_CONTINUING, worker } });
const failed = (worker: string, s: number) => ({ guard: "phase-gate", ts: at(s), detail: { kind: WORKER_SEND_FAILED, worker } });
const stopped = (agent: string, s: number) => ({ guard: "phase-gate", ts: at(s), detail: { kind: SUBAGENT_STOPPED, agent } });
const architectEnded = (s: number) => ({ guard: LEAD_GUARD, ts: at(s), detail: { kind: ARCHITECT_ENDED, agent: "a1" } });
const released = (s: number) => ({ guard: LEAD_GUARD, ts: at(s), detail: { kind: SEAT_RELEASED, issue: 7 } });
const names = (events: Parameters<typeof backgroundWorkers>[0], probe = live) => backgroundWorkers(events, probe).map((w) => w.worker);

describe("backgroundWorkers", () => {
  test("a resumed worker holds until its stop", () => {
    expect(names([continuing("w1", 0), resumed("w1", 1)])).toEqual(["w1"]);
    expect(names([continuing("w1", 0), resumed("w1", 1), stopped("w1", 2)])).toEqual([]);
  });

  // Regression (re-review F1): the architect's end released a worker still running.
  test("the architect's end does not end a worker's hold; only the worker's own stop does", () => {
    const log = [continuing("w1", 0), resumed("w1", 1), architectEnded(2)];
    expect(names(log)).toEqual(["w1"]);
    expect(names([...log, stopped("w1", 30)])).toEqual([]);
  });

  test("the user's release and a stale session end a hold", () => {
    expect(names([resumed("w1", 0), released(1)])).toEqual([]);
    expect(names([released(0), resumed("w2", 1)])).toEqual(["w2"]);
    expect(names([resumed("w1", 0, 999)])).toEqual([]);
  });

  // Regression (re-review F2): an age fallback released long work.
  test("a hold whose session cannot be recognised never expires, and says so", () => {
    const unknown: ProcessProbe = { startTime: () => null };
    expect(backgroundWorkers([resumed("w1", 0)], unknown)).toEqual([{ worker: "w1", since: at(0), unrecognised: true }]);
    // A record with no session at all is unrecognised, too.
    expect(backgroundWorkers([{ guard: "phase-gate", ts: at(0), detail: { kind: WORKER_RESUMED, worker: "w1" } }], live))
      .toEqual([{ worker: "w1", since: at(0), unrecognised: true }]);
  });

  // Regression (re-review U2): the stop can land before the resume record.
  test("for an idle worker, a stop after the continuation's mark cancels the resume record still to come", () => {
    expect(names([continuing("w1", 0), stopped("w1", 1), resumed("w1", 2)])).toEqual([]);
    expect(names([continuing("w1", 0), stopped("w1", 1), resumed("w1", 2), continuing("w1", 3), resumed("w1", 4)])).toEqual(["w1"]);
    // A stop from an earlier run never cancels a later resume, marked or not.
    expect(names([stopped("w1", 0), continuing("w1", 1), resumed("w1", 2)])).toEqual(["w1"]);
    expect(names([stopped("w1", 0), resumed("w1", 2)])).toEqual(["w1"]);
  });

  // Regression (re-review F4): a second send to a worker still running.
  test("a send to a worker already held keeps the hold until a stop after that send's resume record", () => {
    const first = [continuing("w1", 0), resumed("w1", 1)];
    // The first turn's stop lands between the second send's mark and its resume record: still held.
    expect(names([...first, continuing("w1", 2), stopped("w1", 3)])).toEqual(["w1"]);
    expect(names([...first, continuing("w1", 2), stopped("w1", 3), resumed("w1", 4)])).toEqual(["w1"]);
    expect(names([...first, continuing("w1", 2), stopped("w1", 3), resumed("w1", 4), stopped("w1", 9)])).toEqual([]);
    // Without marks (resume records only), the hold is re-established by the second resume record.
    expect(names([resumed("w1", 1), resumed("w1", 4)])).toEqual(["w1"]);
  });

  test("a failed send drops its mark: an idle worker is not held, a held one stays held until its stop", () => {
    expect(names([continuing("w1", 0), failed("w1", 1)])).toEqual([]);
    expect(names([continuing("w1", 0), failed("w1", 1), stopped("w1", 2), resumed("w1", 3)])).toEqual(["w1"]);
    expect(names([continuing("w1", 0), resumed("w1", 1), continuing("w1", 2), failed("w1", 3)])).toEqual(["w1"]);
    expect(names([continuing("w1", 0), resumed("w1", 1), continuing("w1", 2), failed("w1", 3), stopped("w1", 4)])).toEqual([]);
  });
});
