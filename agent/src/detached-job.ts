// Detached, resumable jobs (ADR 2026-073). A host that kills a command at a
// time limit cannot run a check that takes longer in one call. So the core
// runs such work as a job: a runner process in a session of its own
// (src/job-runner.ts), with its output in files, which the call waits on for
// as long as its budget allows and then leaves running. The next call with
// the same key waits again, or collects the result.
//
// Each job is a directory, `.bounded/jobs/<name>/`, holding `spec.json` (what
// was asked), `job.json` (the current run: its id, its runner's pid and that
// pid's start time, the host, when it started, its time limit, its key, the
// tree it started on, how many runs in a row died, and where its output is)
// and `result-<run-id>.json` (exit codes only). The run's raw output and its
// payload live outside the project, in a directory of their own under the
// system's temporary directory, so nothing in the project holds them. Every
// file is written whole (a temporary file renamed into place). Inspecting,
// starting, stopping and collecting happen under one project-wide lock,
// `.bounded/jobs/lock`, held only for those moments, never while a call waits.
//
// A run in the caller's own process (an in-call run) is recorded the same
// way, marked `inline`, so every call sees every run of a job, wherever it
// runs.
//
// The rules, in the order a call applies them:
//   · the current run's result file wins over every liveness judgement; a
//     run's result is collected only by its own id, so a run abandoned
//     earlier can never be collected;
//   · a run is alive while its process runs with the recorded start time on
//     this host; on another host, or when the start time cannot be read, it
//     counts as running until its time limit plus a margin has passed (the
//     host-aware pattern of mutation-journal.ts; doubt fails closed);
//   · a run is dead when it is gone without a result, or past its time limit
//     plus the margin; three deaths in a row for the same key and tree stop
//     the job for good, as a harness bug, until the key or the tree changes;
//   · a run is signalled only when it is provably the job's: its leader runs
//     with the recorded start time, or its leader has gone (or exited, not
//     yet reaped) while a process group with that id still runs (a pid is not
//     reused while its group lives). It is sent SIGTERM, then SIGKILL, each
//     followed by a wait; a group that survives both is an error, never a
//     second run. A run that is not provably the job's is abandoned untouched;
//   · a live run with another key is stopped, and a new one started; a live
//     in-call run is never stopped from another call: that call is refused;
//   · runs that share a group (`JobSpec.group`) overlap only when neither is
//     exclusive: an exclusive run starts only when no other run of the group
//     is live, and no run starts while an exclusive one is.
// The clock is wall time: a machine that sleeps through a run's time limit
// makes a live run look dead on waking, which costs a restart and never
// corrupts a run.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
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
/** Env a job's commands see: the job's directory, the directory its output
 *  and payload go to (outside the project), and its run's id. */
export const JOB_DIR_ENV = "BOUNDED_JOB_DIR";
export const JOB_OUTPUT_ENV = "BOUNDED_JOB_OUTPUT";
export const JOB_RUN_ENV = "BOUNDED_JOB_RUN_ID";

const GRACE_MS = 10_000;
const LOCK_WAIT_MS = 120_000;
const RUNNER = fileURLToPath(new URL("./job-runner.ts", import.meta.url));

/** Which runs may overlap: those of one group, unless either is exclusive. */
export interface JobGroup {
  /** What a refusal calls this job (a gate's name). */
  readonly label: string;
  /** Runs alone: nothing else of the group runs beside it. */
  readonly exclusive: boolean;
  /** How a caller reaches this job (a gate's tool name), for refusals. */
  readonly tool?: string;
}

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
  /** The runs it may or may not overlap. */
  readonly group?: JobGroup;
}

export interface JobRecord {
  readonly runId: string;
  readonly pid: number;
  /** The process's start time, as the probe reads it; null when it could not be read. */
  readonly pidStarted: string | null;
  readonly host: string;
  readonly startedAt: string;
  readonly timeoutMs: number;
  readonly key: string;
  readonly tree?: string;
  readonly deaths: number;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly group?: JobGroup;
  /** Where the run's output and payload are, outside the project. */
  readonly outputDir?: string;
  /** A run in a caller's own process: it has no runner, and no result file. */
  readonly inline?: true;
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

/** A live run that keeps another from starting. */
export interface RunHolder {
  /** Its job name. */
  readonly name: string;
  readonly label: string;
  readonly tool?: string;
  readonly exclusive: boolean;
  readonly startedAt: string;
  /** Running in a caller's own process, not in the background. */
  readonly inline: boolean;
}

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
  /** Another live run (this job's own in-call run, or another of its group) blocks it. */
  | { readonly state: "busy"; readonly holder: RunHolder; readonly runId?: undefined }
  /** Collect-only, and nothing to collect. */
  | { readonly state: "none"; readonly runId?: undefined }
  /** The jobs' lock stayed held for the whole of the call's budget. */
  | { readonly state: "locked"; readonly runId?: undefined };

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

/** Remove a job's directory and its output, wherever that is. */
function removeJob(dir: string): void {
  const outputDir = readRecord(dir)?.outputDir;
  if (outputDir !== undefined) rmSync(outputDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

function readOutcome(dir: string, record: JobRecord): JobOutcome | undefined {
  const raw = readJson(join(dir, resultFile(record.runId))) as RunnerResult | undefined;
  if (raw === undefined || raw.runId !== record.runId) return undefined;
  const payload = record.outputDir === undefined ? undefined : readJson(join(record.outputDir, payloadFile(record.runId)));
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
  const dir = env[JOB_OUTPUT_ENV];
  const runId = env[JOB_RUN_ENV];
  if (dir === undefined || runId === undefined) throw new Error("writeJobPayload runs only inside a background job");
  writeWhole(join(dir, payloadFile(runId)), `${JSON.stringify(payload)}\n`);
}

/** The tail of what a job's commands printed (for the lead, never a role:
 *  it is kept outside the project). */
export function jobOutput(cwd: string, name: string, lines = 30): string {
  const outputDir = readRecord(jobDir(cwd, name))?.outputDir;
  const read = (file: string): string => {
    if (outputDir === undefined) return "";
    try {
      return readFileSync(join(outputDir, file), "utf8");
    } catch {
      return "";
    }
  };
  return `${read("stdout")}${read("stderr")}`.trimEnd().split("\n").slice(-lines).join("\n");
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

const judgeOf = (options: Pick<RunOptions, "probe" | "now" | "kill" | "graceMs">): Judge => ({
  probe: options.probe ?? systemProcesses, now: options.now ?? Date.now,
  kill: options.kill ?? signalProcess, graceMs: options.graceMs ?? GRACE_MS,
});

function lifeOf(dir: string, record: JobRecord, judge: Judge): Life {
  const finished = (): boolean => !record.inline && existsSync(join(dir, resultFile(record.runId)));
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
  const ours = started !== undefined && started === record.pidStarted;
  // A runner that has exited but not yet been reaped by the process that
  // started it (a long-lived host process) still has a start time.
  const exited = ours && judge.probe === systemProcesses && zombie(record.pid);
  if (ours && !exited) {
    return pastLimit ? { kind: "dead", reason: "timed-out", provable: !record.inline } : { kind: "alive" };
  }
  // Gone, exited, or its pid now belongs to another process. It may have finished in between.
  if (finished()) return { kind: "finished" };
  // Its commands may outlive it in its group, which is then provably the job's.
  const orphans = !record.inline && (started === undefined || exited) && judge.kill(-record.pid, 0);
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

// ── Who may run beside whom ─────────────────────────────────────────────────

const holderOf = (name: string, record: JobRecord): RunHolder => ({
  name, label: record.group?.label ?? name, exclusive: record.group?.exclusive ?? false, startedAt: record.startedAt,
  inline: record.inline === true, ...(record.group?.tool !== undefined ? { tool: record.group.tool } : {}),
});

/** A live run of another job in `group` that `name` may not run beside. */
function blocker(cwd: string, name: string, group: JobGroup, judge: Judge): RunHolder | undefined {
  const root = jobsDir(cwd);
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === name) continue;
    const record = readRecord(join(root, entry.name));
    if (record?.group === undefined || record.failed !== undefined) continue;
    if (!group.exclusive && !record.group.exclusive) continue;
    const life = lifeOf(join(root, entry.name), record, judge);
    if (life.kind === "alive" || life.kind === "unverifiable") return holderOf(entry.name, record);
  }
  return undefined;
}

// ── The lock ────────────────────────────────────────────────────────────────

/** Run `fn` under the jobs' lock, waiting for it at most `waitMs`; undefined when it stayed held. */
async function locked<T>(cwd: string, fn: () => Promise<T> | T, waitMs = LOCK_WAIT_MS): Promise<{ readonly value: T } | undefined> {
  const path = join(jobsDir(cwd), "lock");
  const end = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const lock = acquireLock(path, systemProcesses);
    if (lock.ok) {
      try {
        return { value: await fn() };
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= end) return undefined;
    await sleep(Math.min(20 + Math.floor(Math.random() * 30), Math.max(1, end - Date.now())));
  }
}

async function mustLock<T>(cwd: string, fn: () => Promise<T> | T): Promise<T> {
  const done = await locked(cwd, fn);
  if (done === undefined) throw new Error("the background-job lock stayed held");
  return done.value;
}

/**
 * Record a run in this very process (a gate run in the call) as the job's
 * run, so every other call sees it: refused when the job already has a live
 * run, or another run of its group may not run beside it.
 */
export async function claimInline(
  spec: JobSpec, options: { readonly probe?: ProcessProbe; readonly now?: () => number } = {},
): Promise<{ readonly ok: true; release(): void } | { readonly ok: false; readonly holder: RunHolder }> {
  const judge = judgeOf(options);
  const dir = jobDir(spec.cwd, spec.name);
  return mustLock(spec.cwd, () => {
    const existing = readRecord(dir);
    if (existing !== undefined && existing.failed === undefined) {
      const life = lifeOf(dir, existing, judge);
      if (life.kind === "alive" || life.kind === "unverifiable") return { ok: false as const, holder: holderOf(spec.name, existing) };
    }
    if (spec.group !== undefined) {
      const holder = blocker(spec.cwd, spec.name, spec.group, judge);
      if (holder !== undefined) return { ok: false as const, holder };
    }
    removeJob(dir);
    mkdirSync(dir, { recursive: true });
    const runId = randomBytes(8).toString("hex");
    writeRecord(dir, {
      runId, pid: process.pid, pidStarted: judge.probe.startTime(process.pid) ?? null, host: hostname(),
      startedAt: new Date(judge.now()).toISOString(), timeoutMs: spec.timeoutMs ?? JOB_CEILING_MS, key: spec.key, deaths: 0,
      inline: true, ...(spec.tree !== undefined ? { tree: spec.tree } : {}), ...(spec.group !== undefined ? { group: spec.group } : {}),
      ...(spec.meta !== undefined ? { meta: spec.meta } : {}),
    });
    return {
      ok: true as const,
      release: () => {
        if (readRecord(dir)?.runId === runId) removeJob(dir);
      },
    };
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
  const judge = judgeOf(options);
  const budget = options.deadlineMs === undefined ? undefined : callBudgetMs(options.deadlineMs) ?? 0;
  const left = (): number => (budget === undefined ? Number.POSITIVE_INFINITY : budget - (Date.now() - callStart));
  const dir = jobDir(spec.cwd, spec.name);
  let mine: { readonly job: "started" | "restarted"; readonly reason?: string } | undefined;
  for (;;) {
    const held = await locked(spec.cwd, () => inspect(spec, dir, options, judge), Math.min(LOCK_WAIT_MS, left()));
    if (held === undefined) return { state: "locked" };
    const step = held.value;
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
    start ? begin(spec, dir, options, judge, job, reason, deaths) : (removeJob(dir), none);

  let record = readRecord(dir);
  if (record === undefined) return fresh("started");
  // A run in another call's own process is never stopped from here.
  if (record.inline === true) {
    const life = lifeOf(dir, record, judge);
    if (life.kind === "alive" || life.kind === "unverifiable") return { kind: "answer", answer: { state: "busy", holder: holderOf(spec.name, record) } };
    return fresh("started");
  }
  if (record.failed !== undefined) {
    if (record.key === spec.key && record.tree === spec.tree) return failed(record, record.failed, "died");
    return fresh("restarted", record.key !== spec.key ? "args-changed" : "tree-changed");
  }
  const life = lifeOf(dir, record, judge);
  switch (life.kind) {
    case "finished": {
      const outcome = readOutcome(dir, record) ?? { code: null, error: "its result could not be read" };
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
            if (readRecord(dir)?.runId === current.runId) removeJob(dir);
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
        return failed(record, DIED, "died");
      }
      return fresh("restarted", life.reason, deaths);
    }
  }
}

/** Start a run: who it may run beside first, then a clean directory, the runner, the record. */
function begin(spec: JobSpec, dir: string, options: RunOptions, judge: Judge, job: "started" | "restarted", reason: string | undefined, deaths: number): Step {
  if (spec.group !== undefined) {
    const holder = blocker(spec.cwd, spec.name, spec.group, judge);
    if (holder !== undefined) return { kind: "answer", answer: { state: "busy", holder } };
  }
  removeJob(dir);
  mkdirSync(dir, { recursive: true });
  const outputDir = mkdtempSync(join(tmpdir(), "bounded-job-"));
  const runId = randomBytes(8).toString("hex");
  const timeoutMs = spec.timeoutMs ?? JOB_CEILING_MS;
  const commands = spec.sequence ?? (spec.argv !== undefined ? [spec.argv] : []);
  writeWhole(join(dir, "spec.json"), `${JSON.stringify({ name: spec.name, key: spec.key, cwd: spec.cwd, commands, meta: spec.meta ?? {} }, null, 2)}\n`);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...process.env, ...spec.env })) if (value !== undefined) env[name] = value;
  // The host's deadline is the caller's, not the job's: inside a job it is the job's own limit.
  env[COMMAND_TIMEOUT_ENV] = String(timeoutMs);
  env[JOB_DIR_ENV] = dir;
  env[JOB_OUTPUT_ENV] = outputDir;
  env[JOB_RUN_ENV] = runId;
  const log = openSync(join(outputDir, "runner.log"), "w");
  let pid: number | undefined;
  try {
    const child = spawn(process.execPath, [RUNNER, dir, runId, JSON.stringify(commands), outputDir], {
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
    ...(spec.group !== undefined ? { group: spec.group } : {}), outputDir,
  };
  writeRecord(dir, record);
  options.onEvent?.({ kind: job, runId, pid: record.pid, startedAt, ...(reason !== undefined ? { reason } : {}) });
  return { kind: "wait", record, started: { job, ...(reason !== undefined ? { reason } : {}) } };
}

// ── Listing and stopping ────────────────────────────────────────────────────

export type JobState = "running" | "finished" | "dead" | "failed";

/** Every job in `cwd`, and what state its current run is in. */
export function listJobs(
  cwd: string, options: { readonly probe?: ProcessProbe; readonly now?: () => number } = {},
): readonly { readonly name: string; readonly state: JobState; readonly startedAt: string; readonly inline: boolean }[] {
  const judge = judgeOf(options);
  const root = jobsDir(cwd);
  if (!existsSync(root)) return [];
  const out: { name: string; state: JobState; startedAt: string; inline: boolean }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const record = readRecord(dir);
    if (record === undefined) continue;
    const inline = record.inline === true;
    if (record.failed !== undefined) {
      out.push({ name: entry.name, state: "failed", startedAt: record.startedAt, inline });
      continue;
    }
    const life = lifeOf(dir, record, judge);
    const state: JobState = life.kind === "finished" ? "finished" : life.kind === "dead" ? "dead" : "running";
    out.push({ name: entry.name, state, startedAt: record.startedAt, inline });
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
  const judge = judgeOf(options);
  return mustLock(cwd, async () => {
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
        // An in-call run is another process's own work: only its record goes.
        if (life.kind === "alive" && record.inline !== true && !(await stopRun(record, judge))) {
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
      removeJob(dir);
    }
    return report;
  });
}
