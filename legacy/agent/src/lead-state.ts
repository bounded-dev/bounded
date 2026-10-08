// Run state the team lead reads (ADR 2026-048): whether this worktree holds a
// project-local installation, what the guard log says about the current run,
// and whether the selected ticket has a prepared run. Host-neutral: no host
// tool name appears here.

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryState } from "./change-run-status.ts";
import { guardLogPath, RUN_START_GUARD } from "./guard-log.ts";
import { readActiveTicketFile } from "./ticket-design.ts";
import { ownerState, systemProcesses, type ProcessProbe } from "./process-lock.ts";

const INSTALLATION_RELATIVE = ".bounded/installation.json";
const HARNESS_COPY_RELATIVE = ".bounded/harness";

/** The guard the lead's own coordination is logged under. */
export const LEAD_GUARD = "team-lead";
/** The seat name the lead's own entries carry in `detail.role`. */
export const LEAD_SEAT = "team-lead";
/** The read-only investigator the lead may commission. */
export const SCOUT_SEAT = "scout";

// ── One architect per worktree ─────────────────────────────────────────────
//
// Each ticket has its own worktree and at most one architect, the host's own
// subagent, bound to it when the lead launches it after `bounded lead start`
// and continued after `bounded lead reply` (architect-seat.ts, ADR 2026-066).
// The host adapter records each turn's end in the worktree's guard log. The
// cold-relaunch rule (phase-gate.ts) reads that end: a worker launch left
// without an outcome by a turn that has since ended can never be continued.

/** Detail kinds of the background-worker hold (ADR 2026-066). With background
 *  tasks on, a worker continued with the host's continuation may run on after
 *  the call returns, so no gate runs in its ticket worktree while one does.
 *  `worker-continuing` is logged before the continuation is sent, so a stop
 *  that lands before the resume record still cancels it; `worker-send-failed`
 *  says a continuation did not go through; `seat-released` is the user's
 *  `bounded lead release`, which clears every hold. */
export const WORKER_CONTINUING = "worker-continuing";
export const WORKER_RESUMED = "worker-resumed";
export const WORKER_SEND_FAILED = "worker-send-failed";
export const SUBAGENT_STOPPED = "subagent-stopped";
export const SEAT_RELEASED = "seat-released";

export interface BackgroundWorker {
  readonly worker: string;
  readonly since: string;
  /** The session could not be recognised: the hold stays until the worker's
   *  stop is recorded or the user releases the seat. */
  readonly unrecognised?: true;
}

type Logged = { readonly guard: string; readonly detail?: unknown; readonly ts?: string };

/**
 * The workers still holding the gates. Read in log order, which is time
 * order. A hold starts with a successful continuation's resume record and ends
 * only with that worker's recorded stop, its session gone stale, or the user's
 * release. Nothing else ends it: not the architect's end, and not age.
 *
 * Between a continuation's mark (before the send) and its resume record
 * (after it), a stop is ambiguous:
 * - If the worker was idle when the mark was written, the stop can only
 *   answer this send, so it ends the hold and cancels the resume record still
 *   to come.
 * - If the worker was already held, the stop may end the turn before this
 *   send, so it ends nothing. Only a stop recorded after this send's resume
 *   record ends the hold.
 * A failed send drops its mark.
 */
export function backgroundWorkers(events: readonly Logged[], probe: ProcessProbe = systemProcesses): readonly BackgroundWorker[] {
  const running = new Map<string, { since: string; pid?: number; pidStarted?: string }>();
  // Continuations marked but not yet resolved by a resume record or a failure.
  const continuing = new Map<string, { wasHeld: boolean; answered: boolean }>();
  for (const e of events) {
    const d = typeof e.detail === "object" && e.detail !== null ? (e.detail as Detail) : {};
    const kind = d["kind"];
    if (kind === SEAT_RELEASED) {
      running.clear();
      continuing.clear();
      continue;
    }
    const worker = typeof d["worker"] === "string" ? d["worker"] : undefined;
    if (kind === WORKER_CONTINUING && worker !== undefined) {
      continuing.set(worker, { wasHeld: running.has(worker) || continuing.get(worker)?.wasHeld === true, answered: false });
    }
    if (kind === WORKER_SEND_FAILED && worker !== undefined) continuing.delete(worker);
    if (kind === WORKER_RESUMED && worker !== undefined) {
      if (continuing.get(worker)?.answered !== true) {
        running.set(worker, {
          since: e.ts ?? "",
          ...(typeof d["pid"] === "number" ? { pid: d["pid"] } : {}),
          ...(typeof d["pidStarted"] === "string" ? { pidStarted: d["pidStarted"] } : {}),
        });
      }
      continuing.delete(worker);
    }
    if (kind === SUBAGENT_STOPPED && typeof d["agent"] === "string") {
      const agent = d["agent"];
      const pending = continuing.get(agent);
      if (pending === undefined) running.delete(agent);
      else if (!pending.wasHeld) {
        running.delete(agent);
        pending.answered = true;
      }
    }
  }
  const out: BackgroundWorker[] = [];
  for (const [worker, r] of running) {
    const session = r.pid === undefined ? "unknown" : ownerState({ pid: r.pid, started: r.pidStarted ?? "unknown" }, probe);
    if (session === "stale") continue;
    out.push(session === "unknown" ? { worker, since: r.since, unrecognised: true } : { worker, since: r.since });
  }
  return out;
}

/** Detail kind: an architect turn in this worktree ended (`launch` names it). */
export const ARCHITECT_ENDED = "architect-ended";

type Detail = Readonly<Record<string, unknown>>;
const leadDetail = (e: { readonly guard: string; readonly detail?: unknown }): Detail =>
  e.guard === LEAD_GUARD && typeof e.detail === "object" && e.detail !== null ? (e.detail as Detail) : {};

/** Is an architect's end recorded after event `index` — and, when the end
 *  names the architect's agent id, is it `agent`? */
export function architectEndedSince(
  events: readonly { readonly guard: string; readonly detail?: unknown }[],
  index: number,
  agent: string | undefined,
): boolean {
  for (let i = index + 1; i < events.length; i++) {
    const d = leadDetail(events[i]!);
    if (d["kind"] !== ARCHITECT_ENDED) continue;
    const named = d["agent"];
    if (typeof named !== "string" || agent === undefined || named === agent) return true;
  }
  return false;
}

/** An installed project has its manifest and its own harness copy. */
export function isProjectLocalHarness(cwd: string): boolean {
  try {
    return lstatSync(join(cwd, INSTALLATION_RELATIVE)).isFile() &&
      lstatSync(join(cwd, HARNESS_COPY_RELATIVE)).isDirectory();
  } catch {
    return false;
  }
}

export interface RunLogEntry {
  readonly guard: string;
  readonly verdict: unknown;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** The guard log as the run boundary sees it. `absent` is a log that was
 *  never written or was archived at the last boundary. */
export type RunLog =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "read"; readonly state: "delivered" | "undelivered"; readonly entries: readonly RunLogEntry[] };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read and parse the log once. Anything unreadable or unparseable is malformed. */
export function readRunLog(cwd: string): RunLog {
  let raw: string;
  try {
    raw = readFileSync(guardLogPath(cwd), "utf8");
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT" ? { kind: "absent" } : { kind: "malformed" };
  }
  const state = deliveryState(raw);
  if (state === "malformed") return { kind: "malformed" };
  const entries: RunLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return { kind: "malformed" };
    }
    if (!isRecord(event) || typeof event["guard"] !== "string") return { kind: "malformed" };
    const detail = event["detail"];
    entries.push({ guard: event["guard"], verdict: event["verdict"], ...(isRecord(detail) ? { detail } : {}) });
  }
  return { kind: "read", state, entries };
}

/** Entries the lead and its read-only helpers leave: coordination, refused
 *  reads, host declarations, and the tier chosen for a commission. None of
 *  them is evidence that a ticket run started. */
export function isLeadOwnEntry(entry: RunLogEntry): boolean {
  if (entry.guard === LEAD_GUARD || entry.guard === "path-gate" || entry.guard === "host") return true;
  const seat = entry.detail?.["role"];
  return seat === LEAD_SEAT || seat === SCOUT_SEAT;
}

export function hasRunStart(entries: readonly RunLogEntry[]): boolean {
  return entries.some((entry) => entry.guard === RUN_START_GUARD);
}

/** The recorded ticket, only after the lead has prepared a run for it and
 *  before that run's final delivery. */
export function preparedTicket(cwd: string): string | undefined {
  if (!isProjectLocalHarness(cwd)) return undefined;
  const file = readActiveTicketFile(cwd);
  if (file.kind !== "selected") return undefined;
  const log = readRunLog(cwd);
  if (log.kind !== "read" || log.state === "delivered") return undefined;
  return log.entries.some((entry) =>
    entry.guard === LEAD_GUARD && entry.verdict === "pass" &&
    entry.detail?.["kind"] === "run-prepared" && entry.detail["ticket"] === file.ticket)
    ? file.ticket
    : undefined;
}

/** How the lead opened the current, undelivered run for `ticket`: "first" for
 *  a design with no prior delivery, "change" for one with a delivered design to
 *  diff against. A resume keeps the kind of the run it resumed. Undefined when
 *  no lead-prepared run for that ticket is in progress. */
export function preparedRunKind(cwd: string, ticket: string): "first" | "change" | undefined {
  if (!isProjectLocalHarness(cwd)) return undefined;
  const log = readRunLog(cwd);
  if (log.kind !== "read" || log.state === "delivered") return undefined;
  let kind: "first" | "change" | undefined;
  for (const entry of log.entries) {
    if (entry.guard !== LEAD_GUARD || entry.verdict !== "pass" ||
        entry.detail?.["kind"] !== "run-prepared" || entry.detail["ticket"] !== ticket) continue;
    const boundary = entry.detail["boundary"];
    if (boundary === "first" || boundary === "change") kind = boundary;
  }
  return kind;
}
