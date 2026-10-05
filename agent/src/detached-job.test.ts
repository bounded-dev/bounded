import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listJobs, runOrCollect, stopJobs, type JobEvent, type JobSpec } from "./detached-job.ts";
import { systemProcesses, type ProcessProbe } from "./process-lock.ts";

// The core's detached, resumable job (ADR 2026-073): a run started in its own
// session with its output in files, so a call can return while it works and a
// later call collects it. Commands here are `node -e …`.

const DEADLINE = 16_000; // a 1000 ms budget

let cwd = "";
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "bounded-detached-job-")));
});
afterEach(async () => {
  await stopJobs(cwd, { force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const node = (code: string): string[] => [process.execPath, "-e", code];
const spec = (over: Partial<JobSpec> = {}): JobSpec => ({ cwd, name: "test-job", key: "k", argv: node(""), ...over });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) return false;
    await sleep(100);
  }
  return true;
}

describe("runOrCollect", () => {
  test("a sequence stops at the first failing command", async () => {
    const marker = join(cwd, "marker");
    const answer = await runOrCollect(spec({
      argv: undefined,
      sequence: [node(""), node("process.exit(2)"), node(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`)],
    }));
    expect(answer.state).toBe("done");
    if (answer.state !== "done") return;
    expect(answer.outcome.code).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });

  test("a command that cannot start is a recorded result, not a restart", async () => {
    const events: JobEvent[] = [];
    const answer = await runOrCollect(spec({ argv: ["/no/such/program"] }), { onEvent: (e) => events.push(e) });
    expect(answer.state).toBe("done");
    if (answer.state !== "done") return;
    expect(answer.outcome.code).toBeNull();
    expect(events.filter((e) => e.kind === "started")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "restarted")).toHaveLength(0);
  });

  test("a collected result stays until released", async () => {
    const first = await runOrCollect(spec());
    expect(first.state).toBe("done");
    const again = await runOrCollect(spec());
    expect(again.state).toBe("done");
    expect(again.runId).toBe(first.runId);
    if (again.state !== "done") return;
    again.release();
    const fresh = await runOrCollect(spec());
    expect(fresh.runId).not.toBe(first.runId);
  });

  test("a job past its ceiling plus margin is dead even while its process lives", async () => {
    const marker = join(cwd, "marker");
    const sleeper = spec({ argv: node(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 30000)`) });
    const first = await runOrCollect(sleeper, { deadlineMs: DEADLINE });
    expect(first.state).toBe("running");
    if (first.state !== "running") return;
    const later = Date.parse(first.startedAt) + 65 * 60_000 + 1000;
    const second = await runOrCollect(sleeper, { deadlineMs: DEADLINE, now: () => later });
    expect(second).toMatchObject({ state: "running", job: "restarted", reason: "timed-out" });
    expect(await until(() => !groupAlive(first.pid), 12_000)).toBe(true);
    await stopJobs(cwd, { force: true });
    expect(existsSync(marker)).toBe(false);
  }, 40_000);

  test("a pid that is not provably the job's is never signalled, and its late result is never collected", async () => {
    const first = await runOrCollect(spec({ argv: node("setTimeout(() => {}, 1500)") }), { deadlineMs: DEADLINE });
    expect(first.state).toBe("running");
    if (first.state !== "running") return;
    const probe: ProcessProbe = { startTime: (pid) => (pid === first.pid ? "another process" : systemProcesses.startTime(pid)) };
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    });
    const events: JobEvent[] = [];
    const exits2 = spec({ argv: node("process.exit(2)") });
    const second = await runOrCollect(exits2, { probe, kill, onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.kind === "restarted")).toMatchObject({ reason: "dead" });
    expect(second.runId).not.toBe(first.runId);
    for (const [pid] of kill.mock.calls) expect(Math.abs(pid)).not.toBe(first.pid);
    await until(() => !groupAlive(first.pid), 5000);
    await sleep(300);
    const polled = await runOrCollect(exits2, { probe, kill });
    expect(polled.state).toBe("done");
    if (polled.state !== "done") return;
    expect(polled.runId).toBe(second.runId);
    expect(polled.outcome.code).toBe(2);
  }, 20_000);

  test("a group that survives SIGKILL is an ERROR, never a second run", async () => {
    const first = await runOrCollect(spec({ argv: node("setTimeout(() => {}, 30000)") }), { deadlineMs: DEADLINE });
    expect(first.state).toBe("running");
    if (first.state !== "running") return;
    const events: JobEvent[] = [];
    const answer = await runOrCollect(spec({ key: "other", argv: node("setTimeout(() => {}, 30000)") }), {
      deadlineMs: DEADLINE, kill: () => true, graceMs: 300, onEvent: (e) => events.push(e),
    });
    expect(answer.state).toBe("done");
    if (answer.state !== "done") return;
    expect(answer.outcome.error).toMatch(/could not be stopped/);
    expect(events.filter((e) => e.kind === "started" || e.kind === "restarted")).toEqual([]);
    process.kill(-first.pid, "SIGKILL");
  }, 20_000);

  test("a job written on another host is waited on, not killed", async () => {
    const sleeper = spec({ argv: node("setTimeout(() => {}, 30000)") });
    const first = await runOrCollect(sleeper, { deadlineMs: DEADLINE });
    expect(first.state).toBe("running");
    if (first.state !== "running") return;
    const path = join(cwd, ".bounded", "jobs", "test-job", "job.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), host: "another-machine.invalid" }));
    const second = await runOrCollect(sleeper, { deadlineMs: DEADLINE });
    expect(second.state).toBe("running");
    if (second.state !== "running") return;
    expect(second.note).toMatch(/cannot be checked from here/);
    expect(groupAlive(first.pid)).toBe(true);
    process.kill(-first.pid, "SIGKILL");
  }, 20_000);

  test("an abort signal ends an inline wait, not the job", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    const started = Date.now();
    const answer = await runOrCollect(spec({ argv: node("setTimeout(() => {}, 3000)") }), { signal: abort.signal });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(answer.state).toBe("running");
    if (answer.state !== "running") return;
    expect(answer.note).toMatch(/cancelled/);
    const collected = await runOrCollect(spec({ argv: node("setTimeout(() => {}, 3000)") }));
    expect(collected.state).toBe("done");
    if (collected.state !== "done") return;
    expect(collected.runId).toBe(answer.runId);
    expect(collected.outcome.code).toBe(0);
  }, 20_000);

  test("listJobs reports running, finished and dead jobs", async () => {
    const running = await runOrCollect(spec({ name: "running-job", argv: node("setTimeout(() => {}, 30000)") }), { deadlineMs: DEADLINE });
    expect(running.state).toBe("running");
    expect((await runOrCollect(spec({ name: "finished-job" }))).state).toBe("done");
    const dead = await runOrCollect(spec({ name: "dead-job", argv: node("setTimeout(() => {}, 30000)") }), { deadlineMs: DEADLINE });
    expect(dead.state).toBe("running");
    if (dead.state !== "running") return;
    process.kill(-dead.pid, "SIGKILL");
    await until(() => !groupAlive(dead.pid), 5000);
    const states = Object.fromEntries(listJobs(cwd).map((j) => [j.name, j.state]));
    expect(states).toEqual({ "running-job": "running", "finished-job": "finished", "dead-job": "dead" });
  }, 20_000);
});
