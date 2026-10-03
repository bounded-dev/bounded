import { describe, expect, test } from "vitest";
import {
  ARCHITECT_ENDED, backgroundWorkers, LEAD_GUARD, SEAT_RELEASED, SUBAGENT_STOPPED, UNRECOGNISED_WORKER_MAX_AGE_MS, WORKER_CONTINUING,
  WORKER_RESUMED,
} from "./lead-state.ts";
import type { ProcessProbe } from "./process-lock.ts";

// The background-worker hold (ADR 2026-066): it always ends.

const T0 = Date.parse("2026-10-03T08:00:00.000Z");
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const live: ProcessProbe = { startTime: (pid) => (pid === 10 ? "t" : undefined) };
const resumed = (worker: string, s: number, pid = 10) => ({ guard: "phase-gate", ts: at(s), detail: { kind: WORKER_RESUMED, worker, pid, pidStarted: "t" } });
const continuing = (worker: string, s: number) => ({ guard: "phase-gate", ts: at(s), detail: { kind: WORKER_CONTINUING, worker } });
const stopped = (agent: string, s: number) => ({ guard: "phase-gate", ts: at(s), detail: { kind: SUBAGENT_STOPPED, agent } });
const names = (events: Parameters<typeof backgroundWorkers>[0], probe = live, now = T0 + 60_000) => backgroundWorkers(events, probe, now).map((w) => w.worker);

describe("backgroundWorkers", () => {
  test("a resumed worker holds until its stop", () => {
    expect(names([continuing("w1", 0), resumed("w1", 1)])).toEqual(["w1"]);
    expect(names([continuing("w1", 0), resumed("w1", 1), stopped("w1", 2)])).toEqual([]);
  });

  // Regression (re-review U2): the stop can land before the resume record.
  test("a stop recorded after the continuation was marked cancels a later resume record; a new continuation holds again", () => {
    expect(names([continuing("w1", 0), stopped("w1", 1), resumed("w1", 2)])).toEqual([]);
    expect(names([continuing("w1", 0), stopped("w1", 1), resumed("w1", 2), continuing("w1", 3), resumed("w1", 4)])).toEqual(["w1"]);
    // A stop from the worker's earlier, commissioned run never cancels a later resume, marked or not.
    expect(names([stopped("w1", 0), continuing("w1", 1), resumed("w1", 2)])).toEqual(["w1"]);
    expect(names([stopped("w1", 0), resumed("w1", 2)])).toEqual(["w1"]);
  });

  // Regression (re-review R1): a hold with no way out.
  test("a hold ends when its session has gone, when the architect's end is recorded, or when the user releases the seat", () => {
    expect(names([resumed("w1", 0, 999)])).toEqual([]);
    expect(names([resumed("w1", 0), { guard: LEAD_GUARD, ts: at(1), detail: { kind: ARCHITECT_ENDED, agent: "a1" } }])).toEqual([]);
    expect(names([resumed("w1", 0), { guard: LEAD_GUARD, ts: at(1), detail: { kind: SEAT_RELEASED, issue: 7 } }])).toEqual([]);
    expect(names([{ guard: LEAD_GUARD, ts: at(0), detail: { kind: SEAT_RELEASED, issue: 7 } }, resumed("w2", 1)])).toEqual(["w2"]);
  });

  // Regression (re-review U3): an unrecognised session holds only for an hour.
  test("a hold whose session cannot be recognised lasts at most an hour, and says so", () => {
    const unknown: ProcessProbe = { startTime: () => null };
    expect(backgroundWorkers([resumed("w1", 0)], unknown, T0 + 1000)).toEqual([{ worker: "w1", since: at(0), unrecognised: true }]);
    expect(backgroundWorkers([resumed("w1", 0)], unknown, T0 + UNRECOGNISED_WORKER_MAX_AGE_MS + 1)).toEqual([]);
    // A record with no session at all is unrecognised, too.
    expect(backgroundWorkers([{ guard: "phase-gate", ts: at(0), detail: { kind: WORKER_RESUMED, worker: "w1" } }], live, T0 + 1000))
      .toEqual([{ worker: "w1", since: at(0), unrecognised: true }]);
  });
});
