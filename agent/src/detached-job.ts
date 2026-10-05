// Detached, resumable jobs (ADR 2026-073). A host that kills a command at a
// time limit (Claude Code: ten minutes at most) cannot run a check that takes
// longer in one call. So the core runs such work as a job: a runner process in
// a session of its own (src/job-runner.ts), with its output in files, which
// the call waits on for as long as its budget allows and then leaves running.
// The next call with the same key waits again, or collects the result.
//
// Each job is a directory, `.bounded/jobs/<name>/`, holding `spec.json` (what
// was asked), `job.json` (the current run: its id, its runner's pid and that
// pid's start time, the host, when it started, its time limit, its key, the
// tree it started on and how many runs in a row died), the run's output files
// and `result-<run-id>.json` / `payload-<run-id>.json`. Every file is written
// whole (a temporary file renamed into place). Inspecting, starting, stopping
// and collecting happen under one project-wide lock, `.bounded/jobs/lock`,
// held only for those moments, never while a call waits.
//
// The rules, in the order a call applies them:
//   · the current run's result file wins over every liveness judgement; a
//     run's result is collected only by its own id, so a run abandoned
//     earlier can never be collected;
//   · a run is alive while its runner's pid runs with the recorded start time
//     on this host; on another host, or when the start time cannot be read,
//     it counts as running until its time limit plus a margin has passed
//     (the host-aware pattern of mutation-journal.ts; doubt fails closed);
//   · a run is dead when it is gone without a result, or past its time limit
//     plus the margin; three deaths in a row for the same key and tree stop
//     the job for good, as a harness bug, until the key or the tree changes;
//   · a run is signalled only when it is provably the job's: its leader runs
//     with the recorded start time, or no process has its pid but a process
//     group with that id exists (a pid is not reused while its group lives).
//     It is sent SIGTERM, then SIGKILL, each followed by a wait; a group that
//     survives both is an error, never a second run. A run that is not
//     provably the job's is abandoned untouched;
//   · a live run with another key is stopped, and a new one started;
//   · one project-wide slot (`.bounded/jobs/slot`) is held by the one live
//     long-gate run, job or in-process, so two never share one tree.
// The clock is wall time: a machine that sleeps through a run's time limit
// makes a live run look dead on waking, which costs a restart and never
// corrupts a run.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callBudgetMs, COMMAND_TIMEOUT_ENV } from "./host.ts";
import { payloadFile, resultFile, writeWhole, type RunnerResult } from "./job-runner.ts";
import { acquireLock, systemProcesses, type ProcessProbe } from "./process-lock.ts";

export const JOBS_RELATIVE = ".bounded/jobs";
/** Every job's time limit: the runner stops everything it started then. */
export const JOB_CEILING_MS = 60 * 60_000;
/** How long past its time limit a run still counts as running. */
export const JOB_MARGIN_MS = 5 * 60_000;
/** Deaths in a row, for one key and tree, that stop a job for good. */
export const MAX_DEATHS = 3;
/** Env a job's commands see: the job's directory, and its run's id. */
export const JOB_DIR_ENV = "BOUNDED_JOB_DIR";
export const JOB_RUN_ENV = "BOUNDED_JOB_RUN_ID";

const GRACE_MS = 10_000;
const LOCK_WAIT_MS = 120_000;
const RUNNER = fileURLToPath(new URL("./job-runner.ts", import.meta.url));

export interface JobSpec {
  /** The project (or worktree) the job belongs to and runs in. */
  readonly cwd: string;
  /** The job's directory name under `.bounded/jobs/`. */
  readonly name: string;
  /** What the run computes: a call with another key never collects it. */
  readonly key: string;
  /** One command, or a sequence that stops at the first failure. */
  readonly argv?: readonly string[];
  readonly sequence?: readonly (readonly string[])[];
  /** Env for the commands, over this process's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  /** The project's tree when the call started; deaths count per tree. */
  readonly tree?: string;
  /** Recorded with the run, for the caller's own collection rules. */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** Take the project's one long-run slot, under this label. */
  readonly slot?: string;
}

export interface JobRecord {
  readonly runId: string;
  readonly pid: number;
  /** The runner's start time, as the process probe reads it; null when it
   *  could not be read. */
  readonly pidStarted: string | null;
  readonly host: string;
  readonly startedAt: string;
  readonly timeoutMs: number;
  readonly key: string;
  readonly tree?: string;
  readonly deaths: number;
  readonly meta?: Readonly<Record<string, unknown>>;
  /** Set once the job has stopped for good: the error every later call with
   *  the same key and tree answers. */
  readonly failed?: string;
}

export interface JobOutcome {
  /** The command's exit code; null when it never ran to an exit. */
  readonly code: number | null;
  readonly signal?: string;
  readonly timedOut?: true;
  /** Why there is no result: a command that could not start, a run that
   *  could not be stopped, or one that kept dying. */
  readonly error?: string;
  readonly failure?: "start" | "stuck" | "died";
  /** What the run's own command wrote with writeJobPayload. */
  readonly payload?: unknown;
}

export type JobEvent =
  | { readonly kind: "started" | "restarted"; readonly runId: string; readonly pid: number; readonly startedAt: string; readonly reason?: string }
  | { readonly kind: "running"; readonly runId: string; readonly pid: number; readonly startedAt: string; readonly note?: string };

export type JobAnswer =
  | {
    readonly state: "done"; readonly outcome: JobOutcome; readonly runId: string; readonly startedAt: string;
    readonly restarted?: true; readonly reason?: string; readonly meta?: Readonly<Record<string, unknown>>;
    /** Clear the job once its result is recorded; the next call starts afresh. */
    release(): void;
  }
  | {
    readonly state: "running"; readonly runId: string; readonly pid: number; readonly startedAt: string;
    readonly job: "started" | "restarted" | "running"; readonly reason?: string; readonly note?: string;
  }
  /** Another job holds the project's slot. */
  | { readonly state: "busy"; readonly holder: SlotHolder; readonly runId?: undefined }
  /** Collect-only, and nothing to collect. */
  | { readonly state: "none"; readonly runId?: undefined };

export interface RunOptions {
  /** The host's command deadline; undefined waits until the run ends. */
  readonly deadlineMs?: number;
  /** When the call started (ms since the epoch): the budget counts the call's own work. */
  readonly startedAt?: number;
  readonly probe?: ProcessProbe;
  /** The clock runs are judged on (their age against their time limit). */
  readonly now?: () => number;
  /** Ends the wait (not the run). */
  readonly signal?: AbortSignal;
  /** Signal a process or group; true when it exists. The test seam. */
  readonly kill?: (pid: number, signal: NodeJS.Signals | 0) => boolean;
  readonly onEvent?: (event: JobEvent) => void;
  /** How long each of SIGTERM and SIGKILL is given. */
  readonly graceMs?: number;
  /** false: collect or wait on an existing run, never start one. */
  readonly start?: boolean;
  /** A reason to discard a finished run instead of collecting it. */
  readonly accept?: (outcome: JobOutcome, record: JobRecord) => string | undefined;
}

// ── Files ───────────────────────────────────────────────────────────────────

export const jobsDir = (cwd: string): string => join(cwd, JOBS_RELATIVE);
const jobDir = (cwd: string, name: string): string => join(jobsDir(cwd), name);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readRecord(dir: string): JobRecord | undefined {
  const raw = readJson(join(dir, "job.json"));
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r["runId"] !== "string" || typeof r["pid"] !== "number" || typeof r["host"] !== "string" ||
      typeof r["startedAt"] !== "string" || typeof r["timeoutMs"] !== "number" || typeof r["key"] !== "string") return undefined;
  return { deaths: 0, pidStarted: null, ...(r as object) } as JobRecord;
}

function writeRecord(dir: string, record: JobRecord): void {
  writeWhole(join(dir, "job.json"), `${JSON.stringify(record, null, 2)}\n`);
}

function readOutcome(dir: string, runId: string): JobOutcome | undefined {
  const raw = readJson(join(dir, resultFile(runId))) as RunnerResult | undefined;
  if (raw === undefined || raw.runId !== runId) return undefined;
  const payload = readJson(join(dir, payloadFile(runId)));
  return {
    code: typeof raw.code === "number" ? raw.code : null,
    ...(raw.signal !== undefined ? { signal: raw.signal } : {}),
    ...(raw.timedOut === true ? { timedOut: true as const } : {}),
    ...(raw.error !== undefined ? { error: raw.error, failure: "start" as const } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };
}

/** For a job's own command: hand the caller a structured result. */
export function writeJobPayload(payload: unknown, env: Readonly<Record<string, string | undefined>> = process.env): void {
  const dir = env[JOB_DIR_ENV];
  const runId = env[JOB_RUN_ENV];
  if (dir === undefined || runId === undefined) throw new Error("writeJobPayload runs only inside a background job");
  writeWhole(join(dir, payloadFile(runId)), `${JSON.stringify(payload)}\n`);
}

// ── Processes ───────────────────────────────────────────────────────────────

/** Does any process of group `pgid` still run (exited ones waiting to be reaped do not)? */
function groupLive(pgid: number): boolean {
  const run = spawnSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0) {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  return (run.stdout ?? "").split("\n").some((line) => {
    const [group, stat] = line.trim().split(/\s+/);
    return Number(group) === pgid && stat !== undefined && !stat.startsWith("Z");
  });
}

function signalProcess(pid: number, signal: NodeJS.Signals | 0): boolean {
  if (pid < 0 && signal === 0) return groupLive(-pid);
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Has `pid` exited, waiting only to be reaped? */
function zombie(pid: number): boolean {
  const run = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return run.status === 0 && (run.stdout ?? "").trim().startsWith("Z");
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(done, ms);
  function done(): void {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  }
  signal?.addEventListener("abort", done, { once: true });
});

type Life =
  | { readonly kind: "finished" }
  | { readonly kind: "alive" }
  | { readonly kind: "unverifiable"; readonly note: string }
  | { readonly kind: "dead"; readonly reason: "dead" | "timed-out"; readonly provable: boolean };

interface Judge {
  readonly probe: ProcessProbe;
  readonly now: () => number;
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => boolean;
  readonly graceMs: number;
}

function lifeOf(dir: string, record: JobRecord, judge: Judge): Life {
  const finished = (): boolean => existsSync(join(dir, resultFile(record.runId)));
  if (finished()) return { kind: "finished" };
  const pastLimit = judge.now() - Date.parse(record.startedAt) > record.timeoutMs + JOB_MARGIN_MS;
  if (record.host !== hostname()) {
    return pastLimit ? { kind: "dead", reason: "timed-out", provable: false } : {
      kind: "unverifiable",
      note: `it was started on another machine (${record.host}), so whether it still runs cannot be checked from here; it counts as running until its time limit has passed`,
    };
  }
  const started = record.pidStarted === null ? null : judge.probe.startTime(record.pid);
  if (started === null) {
    return pastLimit ? { kind: "dead", reason: "timed-out", provable: false } : {
      kind: "unverifiable",
      note: "whether its process still runs cannot be checked from here; it counts as running until its time limit has passed",
    };
  }
  // A runner that has exited but not yet been reaped by the process that
  // started it (a long-lived host process) still has a start time.
  if (started !== undefined && started === record.pidStarted && !(judge.probe === systemProcesses && zombie(record.pid))) {
    return pastLimit ? { kind: "dead", reason: "timed-out", provable: true } : { kind: "alive" };
  }
  // Gone, or its pid now belongs to another process. It may have finished in between.
  if (finished()) return { kind: "finished" };
  const orphans = started === undefined && judge.kill(-record.pid, 0);
  return { kind: "dead", reason: pastLimit ? "timed-out" : "dead", provable: orphans };
}

/** Stop a run that is provably the job's: SIGTERM, then SIGKILL, each waited for. */
async function stopRun(record: JobRecord, judge: Judge): Promise<boolean> {
  const gone = async (): Promise<boolean> => {
    const end = Date.now() + judge.graceMs;
    for (;;) {
      if (!judge.kill(-record.pid, 0)) return true;
      if (Date.now() >= end) return false;
      await sleep(50);
    }
  };
  if (!judge.kill(-record.pid, 0)) return true;
  judge.kill(-record.pid, "SIGTERM");
  if (await gone()) return true;
  judge.kill(-record.pid, "SIGKILL");
  return gone();
}

// ── The slot ────────────────────────────────────────────────────────────────

export interface SlotHolder {
  /** The job name holding it. */
  readonly name: string;
  /** What to call it in a refusal (a gate's name). */
  readonly label: string;
  readonly pid: number;
  readonly pidStarted: string | null;
  readonly host: string;
  readonly startedAt: string;
}

const slotPath = (cwd: string): string => join(jobsDir(cwd), "slot");

function readSlot(cwd: string): SlotHolder | undefined {
  const raw = readJson(slotPath(cwd));
  if (typeof raw !== "object" || raw === null) return undefined;
  const s = raw as Record<string, unknown>;
  return typeof s["name"] === "string" && typeof s["pid"] === "number" && typeof s["startedAt"] === "string"
    ? { label: String(s["name"]), pidStarted: null, host: hostname(), ...(s as object) } as SlotHolder : undefined;
}

function slotHeld(holder: SlotHolder, judge: Judge): boolean {
  const young = judge.now() - Date.parse(holder.startedAt) <= JOB_CEILING_MS + JOB_MARGIN_MS;
  if (holder.host !== hostname()) return young;
  const started = holder.pidStarted === null ? null : judge.probe.startTime(holder.pid);
  if (started === null) return young;
  return started === holder.pidStarted;
}

/** Who holds the slot against `name`, if anyone. */
function slotBlocker(cwd: string, name: string, judge: Judge): SlotHolder | undefined {
  const holder = readSlot(cwd);
  return holder !== undefined && holder.name !== name && slotHeld(holder, judge) ? holder : undefined;
}

function takeSlot(cwd: string, holder: SlotHolder): void {
  mkdirSync(jobsDir(cwd), { recursive: true });
  writeWhole(slotPath(cwd), `${JSON.stringify(holder)}\n`);
}

function freeSlot(cwd: string, name: string, pid?: number): void {
  const holder = readSlot(cwd);
  if (holder !== undefined && holder.name === name && (pid === undefined || holder.pid === pid)) rmSync(slotPath(cwd), { force: true });
}

// ── The lock ────────────────────────────────────────────────────────────────

async function locked<T>(cwd: string, fn: () => Promise<T> | T): Promise<T> {
  const path = join(jobsDir(cwd), "lock");
  const end = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const lock = acquireLock(path, systemProcesses);
    if (lock.ok) {
      try {
        return await fn();
      } finally {
        lock.release();
      }
    }
    if (Date.now() > end) throw new Error(`the background-job lock stayed held (${lock.reason})`);
    await sleep(20 + Math.floor(Math.random() * 30));
  }
}

/**
 * Take the slot for a long run in this process (an in-process gate run), or
 * say who holds it.
 */
export async function claimSlot(
  cwd: string, name: string, label: string, options: { readonly probe?: ProcessProbe; readonly now?: () => number } = {},
): Promise<{ readonly ok: true; release(): void } | { readonly ok: false; readonly holder: SlotHolder }> {
  const judge: Judge = { probe: options.probe ?? systemProcesses, now: options.now ?? Date.now, kill: signalProcess, graceMs: GRACE_MS };
  return locked(cwd, () => {
    const blocker = slotBlocker(cwd, name, judge);
    if (blocker !== undefined) return { ok: false as const, holder: blocker };
    takeSlot(cwd, {
      name, label, pid: process.pid, pidStarted: judge.probe.startTime(process.pid) ?? null,
      host: hostname(), startedAt: new Date(judge.now()).toISOString(),
    });
    return { ok: true as const, release: () => freeSlot(cwd, name, process.pid) };
  });
}

// ── Running and collecting ──────────────────────────────────────────────────

const STUCK = "its earlier run could not be stopped; this is a harness bug";
const DIED = `its background run died ${MAX_DEATHS} times in a row without a result; this is a harness bug`;

type Step =
  | { readonly kind: "answer"; readonly answer: JobAnswer }
  | { readonly kind: "wait"; readonly record: JobRecord; readonly started?: { readonly job: "started" | "restarted"; readonly reason?: string }; readonly note?: string };

/**
 * Collect the job's finished run, wait on its live one, or start one; under a
 * host deadline wait only as long as the call's budget allows (the deadline's
 * budget less what the call has already spent), else until the run ends.
 */
export async function runOrCollect(spec: JobSpec, options: RunOptions = {}): Promise<JobAnswer> {
  const callStart = options.startedAt ?? Date.now();
  const judge: Judge = {
    probe: options.probe ?? systemProcesses, now: options.now ?? Date.now,
    kill: options.kill ?? signalProcess, graceMs: options.graceMs ?? GRACE_MS,
  };
  const budget = options.deadlineMs === undefined ? undefined : callBudgetMs(options.deadlineMs) ?? 0;
  const left = (): number => (budget === undefined ? Number.POSITIVE_INFINITY : budget - (Date.now() - callStart));
  const dir = jobDir(spec.cwd, spec.name);
  let mine: { readonly job: "started" | "restarted"; readonly reason?: string } | undefined;
  for (;;) {
    const step = await locked(spec.cwd, () => inspect(spec, dir, options, judge));
    if (step.kind === "answer") {
      const answer = step.answer;
      return answer.state === "done" && mine?.job === "restarted"
        ? { ...answer, restarted: true, ...(mine.reason !== undefined ? { reason: mine.reason } : {}) } : answer;
    }
    if (step.started !== undefined) mine = step.started;
    const ended = await waitFor(dir, step.record, left, options.signal, judge);
    if (ended === "changed") continue;
    const note = ended === "aborted"
      ? "the call was cancelled while it waited; the run goes on in the background, and the next call collects it"
      : step.note;
    const answer: JobAnswer = {
      state: "running", runId: step.record.runId, pid: step.record.pid, startedAt: step.record.startedAt,
      job: mine?.job ?? "running",
      ...(mine?.reason !== undefined ? { reason: mine.reason } : {}),
      ...(note !== undefined ? { note } : {}),
    };
    if (answer.job === "running") {
      options.onEvent?.({ kind: "running", runId: answer.runId, pid: answer.pid, startedAt: answer.startedAt, ...(note !== undefined ? { note } : {}) });
    }
    return answer;
  }
}

async function waitFor(
  dir: string, record: JobRecord, left: () => number, signal: AbortSignal | undefined, judge: Judge,
): Promise<"changed" | "budget" | "aborted"> {
  let checked = Date.now();
  for (;;) {
    if (existsSync(join(dir, resultFile(record.runId)))) return "changed";
    if (signal?.aborted === true) return "aborted";
    const remaining = left();
    if (remaining <= 0) return "budget";
    if (Date.now() - checked >= 1000) {
      checked = Date.now();
      const current = readRecord(dir);
      if (current?.runId !== record.runId) return "changed";
      const life = lifeOf(dir, record, judge);
      if (life.kind === "finished" || life.kind === "dead") return "changed";
    }
    await sleep(Math.min(50, remaining), signal);
  }
}

async function inspect(spec: JobSpec, dir: string, options: RunOptions, judge: Judge): Promise<Step> {
  const start = options.start !== false;
  const none: Step = { kind: "answer", answer: { state: "none" } };
  const failed = (record: JobRecord, error: string, failure: "stuck" | "died"): Step => ({
    kind: "answer",
    answer: {
      state: "done", outcome: { code: null, error, failure }, runId: record.runId, startedAt: record.startedAt,
      ...(record.meta !== undefined ? { meta: record.meta } : {}), release: () => {},
    },
  });
  const fresh = (job: "started" | "restarted", reason?: string, deaths = 0): Step =>
    start ? begin(spec, dir, options, judge, job, reason, deaths) : (rmSync(dir, { recursive: true, force: true }), none);

  let record = readRecord(dir);
  if (record === undefined) return fresh("started");
  if (record.failed !== undefined) {
    if (record.key === spec.key && record.tree === spec.tree) return failed(record, record.failed, "died");
    return fresh("restarted", record.key !== spec.key ? "args-changed" : "tree-changed");
  }
  const life = lifeOf(dir, record, judge);
  switch (life.kind) {
    case "finished": {
      const outcome = readOutcome(dir, record.runId) ?? { code: null, error: "its result could not be read" };
      if (record.key !== spec.key) return fresh("restarted", "args-changed");
      const why = options.accept?.(outcome, record);
      if (why !== undefined) return fresh("restarted", why);
      const current = record;
      return {
        kind: "answer",
        answer: {
          state: "done", outcome, runId: current.runId, startedAt: current.startedAt,
          ...(current.meta !== undefined ? { meta: current.meta } : {}),
          release: () => {
            if (readRecord(dir)?.runId === current.runId) rmSync(dir, { recursive: true, force: true });
            freeSlot(spec.cwd, spec.name);
          },
        },
      };
    }
    case "alive":
    case "unverifiable": {
      if (record.key === spec.key) return { kind: "wait", record, ...(life.kind === "unverifiable" ? { note: life.note } : {}) };
      if (life.kind === "alive" && !(await stopRun(record, judge))) return failed(record, STUCK, "stuck");
      return fresh("restarted", "args-changed");
    }
    case "dead": {
      if (life.provable && !(await stopRun(record, judge))) return failed(record, STUCK, "stuck");
      if (record.key !== spec.key) return fresh("restarted", "args-changed");
      if (!start) return fresh("restarted");
      const deaths = record.tree === spec.tree ? record.deaths + 1 : 1;
      if (deaths >= MAX_DEATHS) {
        record = { ...record, deaths, failed: DIED, ...(spec.tree !== undefined ? { tree: spec.tree } : {}) };
        writeRecord(dir, record);
        freeSlot(spec.cwd, spec.name);
        return failed(record, DIED, "died");
      }
      return fresh("restarted", life.reason, deaths);
    }
  }
}

/** Start a run: the slot first, then a clean directory, the runner, the record. */
function begin(spec: JobSpec, dir: string, options: RunOptions, judge: Judge, job: "started" | "restarted", reason: string | undefined, deaths: number): Step {
  if (spec.slot !== undefined) {
    const blocker = slotBlocker(spec.cwd, spec.name, judge);
    if (blocker !== undefined) return { kind: "answer", answer: { state: "busy", holder: blocker } };
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const runId = randomBytes(8).toString("hex");
  const timeoutMs = spec.timeoutMs ?? JOB_CEILING_MS;
  const commands = spec.sequence ?? (spec.argv !== undefined ? [spec.argv] : []);
  writeWhole(join(dir, "spec.json"), `${JSON.stringify({ name: spec.name, key: spec.key, cwd: spec.cwd, commands, meta: spec.meta ?? {} }, null, 2)}\n`);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...process.env, ...spec.env })) if (value !== undefined) env[name] = value;
  // The host's deadline is the caller's, not the job's: inside a job it is the job's own limit.
  env[COMMAND_TIMEOUT_ENV] = String(timeoutMs);
  env[JOB_DIR_ENV] = dir;
  env[JOB_RUN_ENV] = runId;
  const log = openSync(join(dir, "runner.log"), "w");
  let pid: number | undefined;
  try {
    const child = spawn(process.execPath, [RUNNER, dir, runId, JSON.stringify(commands)], {
      cwd: spec.cwd, detached: true, stdio: ["ignore", log, log], env,
    });
    child.on("error", () => {});
    child.unref();
    pid = child.pid;
  } finally {
    closeSync(log);
  }
  const startedAt = new Date(judge.now()).toISOString();
  if (pid === undefined) {
    writeWhole(join(dir, resultFile(runId)), `${JSON.stringify({ runId, code: null, error: "the background runner could not start", step: 0, finishedAt: startedAt })}\n`);
  }
  const started = pid === undefined ? undefined : judge.probe.startTime(pid);
  const record: JobRecord = {
    runId, pid: pid ?? 0, pidStarted: started === undefined ? "gone" : started, host: hostname(), startedAt, timeoutMs,
    key: spec.key, ...(spec.tree !== undefined ? { tree: spec.tree } : {}), deaths, ...(spec.meta !== undefined ? { meta: spec.meta } : {}),
  };
  writeRecord(dir, record);
  if (spec.slot !== undefined && pid !== undefined) {
    takeSlot(spec.cwd, { name: spec.name, label: spec.slot, pid, pidStarted: record.pidStarted, host: record.host, startedAt });
  }
  options.onEvent?.({ kind: job, runId, pid: record.pid, startedAt, ...(reason !== undefined ? { reason } : {}) });
  return { kind: "wait", record, started: { job, ...(reason !== undefined ? { reason } : {}) } };
}

/** The tail of what a job's commands printed (for the lead, never a role:
 *  the path policy denies every role the job's files). */
export function jobOutput(cwd: string, name: string, lines = 30): string {
  const read = (file: string): string => {
    try {
      return readFileSync(join(jobDir(cwd, name), file), "utf8");
    } catch {
      return "";
    }
  };
  return `${read("stdout")}${read("stderr")}`.trimEnd().split("\n").slice(-lines).join("\n");
}

// ── Listing and stopping ────────────────────────────────────────────────────

export type JobState = "running" | "finished" | "dead" | "failed";

/** Every job in `cwd`, and what state its current run is in. */
export function listJobs(
  cwd: string, options: { readonly probe?: ProcessProbe; readonly now?: () => number } = {},
): readonly { readonly name: string; readonly state: JobState; readonly startedAt: string }[] {
  const judge: Judge = { probe: options.probe ?? systemProcesses, now: options.now ?? Date.now, kill: signalProcess, graceMs: GRACE_MS };
  const root = jobsDir(cwd);
  if (!existsSync(root)) return [];
  const out: { name: string; state: JobState; startedAt: string }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const record = readRecord(dir);
    if (record === undefined) continue;
    if (record.failed !== undefined) {
      out.push({ name: entry.name, state: "failed", startedAt: record.startedAt });
      continue;
    }
    const life = lifeOf(dir, record, judge);
    const state: JobState = life.kind === "finished" ? "finished" : life.kind === "dead" ? "dead" : "running";
    out.push({ name: entry.name, state, startedAt: record.startedAt });
  }
  return out;
}

export interface StopReport {
  /** Jobs whose runs were stopped (or abandoned, when not provably theirs) and cleared. */
  readonly stopped: readonly string[];
  /** Finished, dead or failed jobs cleared. */
  readonly cleared: readonly string[];
  /** Live jobs left alone (no force). */
  readonly live: readonly string[];
  /** Live jobs that survived SIGKILL. */
  readonly stuck: readonly string[];
}

/**
 * Clear `cwd`'s jobs (or the named ones): finished, dead and failed jobs are
 * removed; a live one only with `force`, stopped under the killing rule, or
 * abandoned when it is not provably the job's.
 */
export async function stopJobs(
  cwd: string,
  options: {
    readonly force: boolean; readonly names?: readonly string[]; readonly probe?: ProcessProbe;
    readonly kill?: (pid: number, signal: NodeJS.Signals | 0) => boolean; readonly graceMs?: number; readonly now?: () => number;
  },
): Promise<StopReport> {
  const report = { stopped: [] as string[], cleared: [] as string[], live: [] as string[], stuck: [] as string[] };
  const root = jobsDir(cwd);
  if (!existsSync(root)) return report;
  const judge: Judge = {
    probe: options.probe ?? systemProcesses, now: options.now ?? Date.now,
    kill: options.kill ?? signalProcess, graceMs: options.graceMs ?? GRACE_MS,
  };
  return locked(cwd, async () => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || (options.names !== undefined && !options.names.includes(entry.name))) continue;
      const dir = join(root, entry.name);
      const record = readRecord(dir);
      const life = record === undefined || record.failed !== undefined ? undefined : lifeOf(dir, record, judge);
      if (record !== undefined && life !== undefined && (life.kind === "alive" || life.kind === "unverifiable")) {
        if (!options.force) {
          report.live.push(entry.name);
          continue;
        }
        if (life.kind === "alive" && !(await stopRun(record, judge))) {
          report.stuck.push(entry.name);
          continue;
        }
        report.stopped.push(entry.name);
      } else {
        if (record !== undefined && life?.kind === "dead" && life.provable && !(await stopRun(record, judge))) {
          report.stuck.push(entry.name);
          continue;
        }
        report.cleared.push(entry.name);
      }
      rmSync(dir, { recursive: true, force: true });
      freeSlot(cwd, entry.name);
    }
    return report;
  });
}
