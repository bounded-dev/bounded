// Run state the team lead reads (ADR 2026-048): whether this worktree holds a
// project-local installation, what the guard log says about the current run,
// and whether the selected ticket has a prepared run. Host-neutral: no host
// tool name appears here.

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryState } from "./change-run-status.ts";
import { guardLogPath, RUN_START_GUARD } from "./guard-log.ts";
import { readActiveTicketFile } from "./ticket-design.ts";

const INSTALLATION_RELATIVE = ".bounded/installation.json";
const HARNESS_COPY_RELATIVE = ".bounded/harness";

/** The guard the lead's own coordination is logged under. */
export const LEAD_GUARD = "team-lead";
/** The seat name the lead's own entries carry in `detail.role`. */
export const LEAD_SEAT = "team-lead";
/** The read-only investigator the lead may commission. */
export const SCOUT_SEAT = "scout";

// ── One architect at a time ────────────────────────────────────────────────
//
// The lead runs at most one architect at once, project-wide: two architects
// would each commission workers, and the cold-relaunch rule (phase-gate.ts) is
// per role, not per architect. A host adapter records each architect the lead
// launches (with the host's id for that launch) and its end; "running" is a
// launch with no recorded end. Only evidence clears one: the host reporting
// the launch over (completed, failed, interrupted), or the USER releasing it
// with `bounded lead release` after a session died with no end recorded — a
// command the lead itself is never allowed to run.

/** Detail kind: the lead launched an architect (`launch` = the host's id). */
export const ARCHITECT_LAUNCHED = "architect-launched";
/** Detail kind: that architect ended (`launch`), or all were released (`all`). */
export const ARCHITECT_ENDED = "architect-ended";

type Detail = Readonly<Record<string, unknown>>;
const leadDetail = (e: { readonly guard: string; readonly detail?: unknown }): Detail =>
  e.guard === LEAD_GUARD && typeof e.detail === "object" && e.detail !== null ? (e.detail as Detail) : {};

/** The launch ids of architects the lead started whose end is not recorded. */
export function runningArchitects(events: readonly { readonly guard: string; readonly detail?: unknown }[]): readonly string[] {
  const running = new Set<string>();
  for (const e of events) {
    const d = leadDetail(e);
    if (d["kind"] === ARCHITECT_LAUNCHED && typeof d["launch"] === "string") running.add(d["launch"]);
    if (d["kind"] === ARCHITECT_ENDED) {
      if (d["all"] === true) running.clear();
      else if (typeof d["launch"] === "string") running.delete(d["launch"]);
    }
  }
  return [...running];
}

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
