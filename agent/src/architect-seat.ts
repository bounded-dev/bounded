// A ticket's architect seat (ADR 2026-066): one architect per ticket worktree,
// running as the host's own standard subagent.
//
// The core never launches anything. `bounded lead start` prepares the
// worktree and leaves ONE pending launch in the main worktree; the lead then
// commissions the architect with its host's subagent tool, and the host
// adapter binds that launch to the pending ticket and records the seat's
// life here, in the ticket worktree:
//
//   pending launch  → written by `start`, under the lead's lock; at most one
//                     exists, so the next architect launch binds to exactly it
//   running         → the adapter bound a launch (or a continuation) to it
//   ended           → the host reported the subagent stopped
//
// `bounded lead reply` leaves a pending reply the same way: the adapter
// allows a continuation only of that architect, carrying exactly that
// message. A seat recorded as running whose host session has gone (by pid and
// start time, process-lock.ts) is reported as lost, never as running.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logGuardEvent } from "./guard-log.ts";
import { ARCHITECT_ENDED, LEAD_GUARD } from "./lead-state.ts";
import { ownerState, systemProcesses, type ProcessProbe } from "./process-lock.ts";

export const ARCHITECT_DIR_RELATIVE = ".bounded/architect";
const STATE = "state.json";
const PENDING_LAUNCH_RELATIVE = ".bounded/lead/pending-launch.json";
const PENDING_REPLIES_RELATIVE = ".bounded/lead/pending-replies";
/** A claim on the pending launch that has not bound by then is stale. */
export const LAUNCH_CLAIM_MAX_AGE_MS = 15 * 60 * 1000;

/** A host adapter's half (hosts/<host>/architect-seat.ts): how the lead
 *  commissions and continues an architect, the host's name for a model, and
 *  a preflight saying why the worktree's gate would not hold. */
export interface ArchitectHost {
  readonly name: string;
  model(pattern: string): string | undefined;
  preflight(worktree: string): string | undefined;
  /** What the lead does next to start the bound architect. */
  launchInstruction(launch: PendingLaunch): string;
  /** What the lead does next to pass a reply to the architect. */
  replyInstruction(reply: PendingReply): string;
}

export interface PendingLaunch {
  readonly issue: number;
  readonly worktree: string;
  /** The architect's opening brief; the adapter makes the launch carry exactly this. */
  readonly brief: string;
  /** The host's name for the configured architect model, when one is configured. */
  readonly model?: string;
  readonly createdAt: string;
  /** The host's id for the launch call that claimed it, once claimed. */
  readonly claimedBy?: string;
  /** When, and by which host process, it was claimed: a claim whose
   *  claimant has gone, or that never bound in time, is stale. */
  readonly claimedAt?: string;
  readonly claimant?: { readonly pid: number; readonly pidStarted: string };
}

export interface PendingReply {
  readonly issue: number;
  readonly worktree: string;
  /** The host's id for the architect the reply continues. */
  readonly agent: string;
  readonly message: string;
  readonly createdAt: string;
}

export interface ArchitectState {
  /** The host's id for the architect subagent. */
  readonly agent: string;
  readonly turn: number;
  readonly state: "running" | "ended";
  /** The host process the subagent runs in, so a dead session is never "running". */
  readonly pid: number;
  readonly pidStarted: string;
  readonly startedAt: string;
  readonly endedAt?: string;
}

export type ArchitectStatus =
  | { readonly kind: "none" }
  | { readonly kind: "running"; readonly turn: number; readonly since: string; readonly agent: string }
  | { readonly kind: "ended"; readonly turn: number; readonly agent: string }
  /** Recorded as running, but its host session is gone. */
  | { readonly kind: "lost"; readonly turn: number; readonly agent: string };

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

// ── Pending launch and reply (main worktree) ────────────────────────────────

export function readPendingLaunch(main: string): PendingLaunch | undefined {
  const raw = readJson<PendingLaunch>(join(main, PENDING_LAUNCH_RELATIVE));
  return raw !== undefined && typeof raw.issue === "number" && typeof raw.worktree === "string" && typeof raw.brief === "string" ? raw : undefined;
}

export function writePendingLaunch(main: string, launch: PendingLaunch): void {
  writeJson(join(main, PENDING_LAUNCH_RELATIVE), launch);
}

export function clearPendingLaunch(main: string): void {
  rmSync(join(main, PENDING_LAUNCH_RELATIVE), { force: true });
}

/** Whether a claim on the pending launch can no longer bind: its claimant
 *  is gone, or it is older than LAUNCH_CLAIM_MAX_AGE_MS. */
export function claimStale(pending: PendingLaunch, probe: ProcessProbe = systemProcesses, now: number = Date.now()): boolean {
  if (pending.claimedBy === undefined) return false;
  if (pending.claimant !== undefined &&
      ownerState({ pid: pending.claimant.pid, started: pending.claimant.pidStarted }, probe) === "stale") return true;
  const at = pending.claimedAt === undefined ? Number.NaN : Date.parse(pending.claimedAt);
  return !Number.isFinite(at) || now - at > LAUNCH_CLAIM_MAX_AGE_MS;
}

/** Release a claim on the pending launch, so the lead can launch again. */
export function releaseLaunchClaim(main: string): void {
  const pending = readPendingLaunch(main);
  if (pending?.claimedBy === undefined) return;
  const { claimedBy: _by, claimedAt: _at, claimant: _who, ...open } = pending;
  writePendingLaunch(main, open);
}

/** Mark the pending launch as taken by one launch call; a second call is
 *  refused while the first claim can still bind. */
export function claimPendingLaunch(
  main: string, by: string, claimant: { readonly pid: number; readonly pidStarted: string },
  options: { readonly probe?: ProcessProbe; readonly now?: number } = {},
): PendingLaunch | { readonly error: string } {
  const pending = readPendingLaunch(main);
  if (pending === undefined) return { error: "no ticket is waiting for its architect — run bounded lead start <issue> first" };
  if (pending.claimedBy !== undefined && pending.claimedBy !== by && !claimStale(pending, options.probe, options.now)) {
    return { error: `ticket #${pending.issue}'s architect launch is already under way; one architect per start` };
  }
  const claimed = { ...pending, claimedBy: by, claimedAt: new Date(options.now ?? Date.now()).toISOString(), claimant };
  writePendingLaunch(main, claimed);
  return claimed;
}

const replyPath = (main: string, issue: number): string => join(main, PENDING_REPLIES_RELATIVE, `${issue}.json`);

/** Each ticket's pending reply, by issue: one ticket's never blocks another's. */
export function readPendingReply(main: string, issue: number): PendingReply | undefined {
  const raw = readJson<PendingReply>(replyPath(main, issue));
  return raw !== undefined && typeof raw.agent === "string" && typeof raw.message === "string" ? raw : undefined;
}

/** The pending reply prepared for the architect `agent`, if any. */
export function pendingReplyFor(main: string, agent: string): PendingReply | undefined {
  const dir = join(main, PENDING_REPLIES_RELATIVE);
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir)) {
    const match = /^([1-9][0-9]*)\.json$/.exec(name);
    const reply = match === null ? undefined : readPendingReply(main, Number(match[1]));
    if (reply?.agent === agent) return reply;
  }
  return undefined;
}

export function writePendingReply(main: string, reply: PendingReply): void {
  writeJson(replyPath(main, reply.issue), reply);
}

export function clearPendingReply(main: string, issue: number): void {
  rmSync(replyPath(main, issue), { force: true });
}

/**
 * Whether `agent`'s seat may be continued now: it is the worktree's recorded
 * architect and it is not running. A seat whose session ended without a
 * recorded stop (lost) is continuable like one that stopped.
 */
export function seatContinuable(worktree: string, agent: string, probe: ProcessProbe = systemProcesses): boolean {
  const status = architectStatus(worktree, probe);
  return (status.kind === "ended" || status.kind === "lost") && status.agent === agent;
}

// ── The seat's life (ticket worktree) ───────────────────────────────────────

export function readArchitectState(worktree: string): ArchitectState | undefined {
  const raw = readJson<ArchitectState>(join(worktree, ARCHITECT_DIR_RELATIVE, STATE));
  return raw !== undefined && typeof raw.agent === "string" && typeof raw.turn === "number" ? raw : undefined;
}

/** The host bound a launch, or a continuation, to this worktree's architect. */
export function recordArchitectRunning(
  worktree: string, agent: string, host: { readonly pid: number; readonly pidStarted: string },
): ArchitectState {
  const previous = readArchitectState(worktree);
  const state: ArchitectState = {
    agent, turn: (previous?.turn ?? 0) + 1, state: "running", pid: host.pid, pidStarted: host.pidStarted,
    startedAt: new Date().toISOString(),
  };
  writeJson(join(worktree, ARCHITECT_DIR_RELATIVE, STATE), state);
  return state;
}

/** The host reported the architect stopped. Only the recorded architect's end counts. */
export function recordArchitectEnded(worktree: string, agent: string): boolean {
  const state = readArchitectState(worktree);
  if (state === undefined || state.agent !== agent || state.state === "ended") return false;
  writeJson(join(worktree, ARCHITECT_DIR_RELATIVE, STATE), { ...state, state: "ended", endedAt: new Date().toISOString() });
  logGuardEvent(worktree, {
    guard: LEAD_GUARD, verdict: "pass", summary: `architect turn ${state.turn} ended`,
    detail: { kind: ARCHITECT_ENDED, launch: `turn-${state.turn}`, agent },
  });
  return true;
}

export function architectStatus(worktree: string, probe: ProcessProbe = systemProcesses): ArchitectStatus {
  const state = readArchitectState(worktree);
  if (state === undefined) return { kind: "none" };
  if (state.state === "ended") return { kind: "ended", turn: state.turn, agent: state.agent };
  return ownerState({ pid: state.pid, started: state.pidStarted }, probe) === "stale"
    ? { kind: "lost", turn: state.turn, agent: state.agent }
    : { kind: "running", turn: state.turn, since: state.startedAt, agent: state.agent };
}

/** A message that a host's tool could read as an option, or that hides one. */
export function flagLike(message: string): boolean {
  return message.trimStart().startsWith("-");
}
