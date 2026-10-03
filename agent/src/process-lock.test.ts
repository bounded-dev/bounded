import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { acquireLock, ownerState, systemProcesses, type ProcessProbe } from "./process-lock.ts";

// A lock owned by pid and start time, taken over only atomically and only on
// evidence (ADR 2026-066).

let dir = "";
let path = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bounded-lock-"));
  path = join(dir, "lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Processes `running` run, each started at "t"; `unknown` cannot be told. */
const probe = (running: readonly number[], unknown: readonly number[] = []): ProcessProbe => ({
  startTime: (pid) => (unknown.includes(pid) ? null : running.includes(pid) ? "t" : undefined),
});
const holder = (pid: number, started = "t"): void => writeFileSync(path, JSON.stringify({ pid, started }));

describe("ownerState", () => {
  test("the same pid and start time is alive; a gone or reused pid is stale; a failed probe is unknown", () => {
    expect(ownerState({ pid: 1, started: "t" }, probe([1]))).toBe("alive");
    expect(ownerState({ pid: 1, started: "t" }, probe([]))).toBe("stale");
    expect(ownerState({ pid: 1, started: "earlier" }, probe([1]))).toBe("stale");
    expect(ownerState({ pid: 1, started: "t" }, probe([], [1]))).toBe("unknown");
    expect(ownerState({ pid: 1, started: "unknown" }, probe([1]))).toBe("unknown");
  });
  test("the system probe knows this process and no process at an unused pid", () => {
    expect(typeof systemProcesses.startTime(process.pid)).toBe("string");
    expect(systemProcesses.startTime(2 ** 22 + 7)).toBeUndefined();
  });
});

describe("acquireLock", () => {
  test("a free lock is taken and released; a live holder refuses", () => {
    const a = acquireLock(path, probe([10, 11]), 10);
    expect(a.ok).toBe(true);
    const b = acquireLock(path, probe([10, 11]), 11);
    expect(b).toMatchObject({ ok: false, reason: "held by pid 10" });
    if (a.ok) a.release();
    expect(existsSync(path)).toBe(false);
  });

  test("a stale lock is taken over; nothing else is left behind", () => {
    holder(99);
    const taken = acquireLock(path, probe([10]), 10);
    expect(taken.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ pid: 10, started: "t" });
    expect(readdirSync(dir)).toEqual(["lock"]);
  });

  test("an owner whose liveness cannot be told is not stale: the taker refuses and says how to clear it", () => {
    holder(99);
    const refused = acquireLock(path, probe([10], [99]), 10);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain(`remove ${path}`);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(99);
  });

  // Regression (re-review): two takers that both judged the same lock stale
  // must not both end up holding it.
  test("two takers of one stale lock: exactly one holds it", () => {
    holder(99);
    // Taker B judges 99 stale; before B claims it, taker A takes it over.
    let interleaved = false;
    const racing: ProcessProbe = {
      startTime(pid) {
        if (pid === 99 && !interleaved) {
          interleaved = true;
          const a = acquireLock(path, probe([10, 11]), 10);
          expect(a.ok).toBe(true);
        }
        return pid === 99 ? undefined : "t";
      },
    };
    const b = acquireLock(path, racing, 11);
    expect(b).toMatchObject({ ok: false, reason: "held by pid 10" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ pid: 10, started: "t" });
  });

  test("a release never removes another holder's lock", () => {
    const a = acquireLock(path, probe([10]), 10);
    holder(12);
    if (a.ok) a.release();
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(12);
  });
});
