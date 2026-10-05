// Running a gate, from any host (ADR 2026-034, ADR 2026-073). Both front
// doors — `bounded gates` and pi's gate tools — call `runGate`, so how a gate
// runs never depends on which host asked.
//
// A gate the registry marks `longRunning` (a pack's delivery, test and
// measurement gates) can outlast a host's command limit. Under a host deadline (BOUNDED_COMMAND_TIMEOUT_MS) its whole
// run is a background job (src/detached-job.ts): the worker
// (gate-job-worker.ts) runs the gate's `prepare` and `run` in a session of its
// own, and the call waits for as long as its budget allows, then answers
// RUNNING. The next call with the same arguments waits again or collects the
// verdict. Without a deadline (pi, a bare shell) the gate runs in the call,
// after first collecting or waiting on any job a deadline-bound call started.
//
// A job's key is the gate and its arguments, never the role. A finished run is
// collected over the tree it left: a tree changed since discards it and starts
// afresh, and a `reads-tree` gate whose tree changed while it ran is a BLOCK,
// because its result is not evidence about any one tree. Every verdict the
// core substitutes for the gate's own is logged under the gate's own guard,
// where phase timing and the board read it; the core's own guard `gate-job`
// carries only polls and pass-through collection, whose verdict the gate
// itself logged inside the job. A refusal to start, which runs nothing, is
// the core's record (`job-refused`), never the gate's verdict.
//
// Which long runs may overlap, in a call or in the background: never two runs
// of one gate; a `writes-tree` gate (it changes the project's files) runs
// alone; `reads-tree` gates run alongside each other (ADR 2026-021). A
// refusal names what is running in the calling role's own terms: a gate the
// role cannot call is never offered to it.

import { fileURLToPath } from "node:url";
import { runGateWithBoard } from "./board-sync.ts";
import type { GateArgs, GateCommand } from "./gate-command.ts";
import { packsDir as defaultPacksDir } from "./gate-discovery.ts";
import { gateRunning, type GateResult } from "./gate-result.ts";
import { logGuardEvent } from "./guard-log.ts";
import { commandTimeoutMs } from "./host.ts";
import { claimInline, runOrCollect, type JobAnswer, type JobEvent, type JobOutcome, type JobSpec, type RunHolder } from "./detached-job.ts";
import { asRole } from "./path-gate.ts";
import { ROLE_TOOLS } from "./path-policy.ts";
import { treeFingerprint } from "./tree-fingerprint.ts";
import type { Tracker } from "./tracker.ts";

/** The core's guard for job polls and pass-through collection. */
export const GATE_JOB_GUARD = "gate-job";
/** The job directory of a gate's background run. */
export const gateJobName = (gate: string): string => `gate-${gate}`;

/** What every long gate's description says where a host renders it (ADR 2026-018). */
export const LONG_RUNNING_NOTE =
  "On a host with a command time limit this gate may answer RUNNING: call it again with the same arguments until it gives a verdict.";

/** A gate's description as hosts show it: a long gate's carries the RUNNING note. */
export function longRunningNote(gate: GateCommand): string {
  return gate.longRunning === undefined ? gate.description : `${gate.description} ${LONG_RUNNING_NOTE}`;
}

const WORKER = fileURLToPath(new URL("./gate-job-worker.ts", import.meta.url));

/** What a background run's worker hands back. */
export interface GatePayload {
  readonly result: GateResult;
  /** The project's tree after `prepare`, before `run`. */
  readonly startTree: string;
  /** The project's tree after `run`. */
  readonly endTree: string;
}

export interface RunGateOptions {
  /** Where the gates come from (default: this harness's packs). Only an
   *  in-process caller passes another; a job records it, and a job recorded
   *  with another is not collected. */
  readonly packsDir?: string;
  /** The session's role: the route of a core BLOCK, and the board's default route. */
  readonly role?: string;
  /** Ends an in-call wait on a background run, never the run. */
  readonly signal?: AbortSignal;
  readonly open: (cwd: string) => Tracker;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** When the call started (ms since the epoch); the budget counts from it. */
  readonly startedAt?: number;
}

/** Arguments in a stable order, so a key never depends on how they were given. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** A gate's job key: its name and its arguments, nothing else (not the role). */
export function gateJobKey(gate: string, args: GateArgs): string {
  return JSON.stringify({ gate, args: canonical(args) });
}

function logged(cwd: string, gate: string, result: GateResult): GateResult {
  logGuardEvent(cwd, { guard: gate, verdict: result.verdict, summary: result.summary, detail: result.detail });
  return result;
}

function substitute(cwd: string, gate: string, code: 1 | 2, message: string, detail: Record<string, unknown>, route?: string): GateResult {
  return logged(cwd, gate, {
    code, verdict: code === 1 ? "block" : "error", summary: message,
    lines: [`${gate}: ${code === 1 ? "BLOCK" : "ERROR"} — ${message}`, ...(route !== undefined ? [`${gate}: route → ${route}`] : [])],
    detail: { ...detail, ...(route !== undefined ? { route } : {}) },
  });
}

/** A gate cannot answer RUNNING itself, by code or by verdict: only the background runner does. */
function noOwnRunning(cwd: string, gate: string, result: GateResult): GateResult {
  return result.code === 3 || result.verdict === "running"
    ? substitute(cwd, gate, 2, "a gate cannot answer RUNNING; only the harness's background runner does", { reason: "gate-claimed-running" })
    : result;
}

/** A gate that did not start: an ERROR that ran nothing, so the board and the
 *  delivery evidence ignore it (`ran: false`), logged as the core's own record. */
export function notStarted(cwd: string, gate: string, message: string, detail: Record<string, unknown>): GateResult {
  logGuardEvent(cwd, { guard: GATE_JOB_GUARD, verdict: "error", summary: `${gate} did not start: ${message}`, detail: { kind: "job-refused", gate, ...detail } });
  return { code: 2, verdict: "error", summary: message, lines: [`${gate}: ERROR — ${message}`], detail: { ...detail, ran: false } };
}

/** Why `gate` cannot start beside `holder`, in the calling role's terms. */
function busyRefusal(cwd: string, gate: string, holder: RunHolder, role: string | undefined): GateResult {
  const known = asRole(role);
  const callable = known === undefined || (holder.tool !== undefined && ROLE_TOOLS[known].includes(holder.tool));
  const message = holder.label === gate
    ? `${gate} is running now in another call (started ${holder.startedAt}); call ${gate} again once it has finished`
    : !callable
      ? `${holder.label} is running (started ${holder.startedAt}) and ${gate} cannot run alongside it; wait for it to finish, then call ${gate} again`
      : holder.inline
        ? `${holder.label} is running now in another call (started ${holder.startedAt}) and ${gate} cannot run alongside it; call ${gate} again once it has finished`
        : `${holder.label} is still running in the background (started ${holder.startedAt}); call ${holder.label} again to collect it first, then run ${gate}`;
  return notStarted(cwd, gate, message, { reason: "busy", holder: holder.label });
}

function isPayload(value: unknown): value is GatePayload {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  const r = p["result"] as Record<string, unknown> | undefined;
  return typeof p["startTree"] === "string" && typeof p["endTree"] === "string" && typeof r === "object" && r !== null &&
    typeof r["code"] === "number" && typeof r["summary"] === "string" && Array.isArray(r["lines"]);
}

/** The verdict a finished background run stands for. */
function collected(cwd: string, gate: GateCommand, outcome: JobOutcome, runId: string, role: string | undefined): GateResult {
  if (outcome.failure === "stuck") {
    return substitute(cwd, gate.name, 2, `${gate.name}'s earlier run could not be stopped; this is a harness bug`, { reason: "job-stuck" }, "user");
  }
  if (outcome.failure === "died") {
    return substitute(cwd, gate.name, 2, `${gate.name}'s background run died 3 times in a row without a result; this is a harness bug`,
      { reason: "job-died" }, "user");
  }
  if (!isPayload(outcome.payload)) {
    if (outcome.timedOut === true) {
      return substitute(cwd, gate.name, 2, `${gate.name}'s background run never completed within its 60-minute limit`, { reason: "job-timed-out" }, "user");
    }
    const exit = outcome.code === null ? (outcome.signal ?? outcome.error ?? "none") : String(outcome.code);
    return substitute(cwd, gate.name, 2, `${gate.name}'s background run ended without a verdict (exit ${exit})`, { reason: "job-no-verdict" }, "user");
  }
  const { result, startTree, endTree } = outcome.payload;
  if (result.code === 3) return noOwnRunning(cwd, gate.name, result);
  if (gate.longRunning === "reads-tree" && startTree !== endTree) {
    return substitute(cwd, gate.name, 1, `the project's files changed while ${gate.name} ran, so its result is not evidence; run ${gate.name} again`,
      { reason: "tree-changed-during-run" }, role ?? "architect");
  }
  logGuardEvent(cwd, {
    guard: GATE_JOB_GUARD, verdict: "pass", summary: `${gate.name}: collected its background run's verdict`,
    detail: { kind: "job-collected", gate: gate.name, code: result.code, runId },
  });
  return result;
}

/** Log a job's start, restart or poll where its readers look. */
function logEvent(cwd: string, gate: string, event: JobEvent): void {
  if (event.kind === "running") {
    logGuardEvent(cwd, {
      guard: GATE_JOB_GUARD, verdict: "running", summary: `${gate} is still running in the background`,
      detail: { kind: "job-running", gate, runId: event.runId, pid: event.pid, startedAt: event.startedAt },
    });
    return;
  }
  logGuardEvent(cwd, {
    guard: gate, verdict: "running",
    summary: `${gate} ${event.kind === "started" ? "started" : "restarted"} in the background`,
    detail: {
      kind: event.kind === "started" ? "job-started" : "job-restarted",
      pid: event.pid, runId: event.runId, startedAt: event.startedAt, ...(event.reason !== undefined ? { reason: event.reason } : {}),
    },
  });
}

/** prepare, then run, in this process. */
async function inline(cwd: string, gate: GateCommand, args: GateArgs): Promise<GateResult> {
  const prepared = gate.prepare === undefined ? undefined : await gate.prepare(cwd);
  return noOwnRunning(cwd, gate.name, prepared ?? await gate.run(cwd, args));
}

/** The answer to one call of a long gate, and what to do once it is recorded. */
async function longRun(
  cwd: string, gate: GateCommand, args: GateArgs, options: RunGateOptions,
): Promise<{ readonly result: GateResult; readonly release?: () => void }> {
  const env = options.env ?? process.env;
  const packs = options.packsDir ?? defaultPacksDir();
  const deadlineMs = commandTimeoutMs(env);
  const spec: JobSpec = {
    cwd, name: gateJobName(gate.name), key: gateJobKey(gate.name, args),
    group: { label: gate.name, exclusive: gate.longRunning === "writes-tree", ...(gate.tool !== undefined ? { tool: gate.tool } : {}) },
    argv: [process.execPath, WORKER, packs, cwd, gate.name, JSON.stringify(args)],
    tree: treeFingerprint(cwd, packs),
    meta: { gate: gate.name, packsDir: packs },
  };
  const accept = (outcome: JobOutcome, record: { readonly meta?: Readonly<Record<string, unknown>> }): string | undefined => {
    if (record.meta?.["packsDir"] !== packs) return "packs-changed";
    if (isPayload(outcome.payload) && outcome.payload.endTree !== treeFingerprint(cwd, packs)) return "tree-changed";
    return undefined;
  };
  const onEvent = (event: JobEvent): void => logEvent(cwd, gate.name, event);
  const answerOf = async (answer: JobAnswer): Promise<{ readonly result: GateResult; readonly release?: () => void }> => {
    switch (answer.state) {
      case "busy": return { result: busyRefusal(cwd, gate.name, answer.holder, options.role) };
      case "locked": return {
        result: notStarted(cwd, gate.name, `another call is checking ${gate.name}'s background runs right now; call ${gate.name} again`, { reason: "locked" }),
      };
      case "running": return {
        result: gateRunning(gate.name, {
          startedAt: answer.startedAt, job: answer.job, pid: answer.pid,
          ...(answer.reason !== undefined ? { reason: answer.reason } : {}), ...(answer.note !== undefined ? { note: answer.note } : {}),
        }),
      };
      case "done": return { result: collected(cwd, gate, answer.outcome, answer.runId, options.role), release: answer.release };
      case "none": {
        // The run in this call is recorded as the gate's run, so no other call starts one beside it.
        const claim = await claimInline(spec);
        if (!claim.ok) return { result: busyRefusal(cwd, gate.name, claim.holder, options.role) };
        try {
          return { result: await inline(cwd, gate, args) };
        } finally {
          claim.release();
        }
      }
    }
  };
  const common = {
    accept, onEvent, ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.startedAt !== undefined ? { startedAt: options.startedAt } : {}),
  };
  // No deadline: the run belongs in this call, once any job is out of the way.
  if (deadlineMs === undefined) return answerOf(await runOrCollect(spec, { ...common, start: false }));
  return answerOf(await runOrCollect(spec, { ...common, deadlineMs }));
}

/**
 * Run one gate the way every host does: in a ticket worktree with the board
 * kept in step, a long gate as a background job under a host deadline. A
 * collected result is cleared only after it has been logged and the board
 * has been updated (or its update left pending).
 */
export async function runGate(cwd: string, gate: GateCommand, args: GateArgs, options: RunGateOptions): Promise<GateResult> {
  if (gate.longRunning === undefined) {
    return runGateWithBoard(cwd, gate, () => inline(cwd, gate, args), options.open, options.role);
  }
  let release: (() => void) | undefined;
  const result = await runGateWithBoard(cwd, gate, async () => {
    const answer = await longRun(cwd, gate, args, options);
    release = answer.release;
    return answer.result;
  }, options.open, options.role);
  release?.();
  return result;
}
