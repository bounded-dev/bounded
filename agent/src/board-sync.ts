// The board follows the gates (ADR 2026-066). In a ticket worktree every gate
// run is mirrored on the ticket's issue: its one-line summary as a comment; a
// refusal as a `blocked: <route>` label naming the role the work went back to,
// cleared by that gate's next pass; and a pass that reaches a milestone as the
// board Status it earns (design frozen → Building, delivered → Awaiting
// Merge) or, for a published design handoff, the release of the tickets
// waiting on it.
//
// The board must never disagree with the worktree. A gate in a ticket
// worktree therefore first replays any board update an earlier run could not
// make, then checks the tracker is reachable, and refuses (routed to the user)
// when either fails, before the gate runs. An update that fails after the gate
// ran is kept as pending, and the result says so; the next gate or command
// cannot run until it has been replayed.

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { systemProcesses } from "./process-lock.ts";
import { join } from "node:path";
import type { GateMilestone } from "./gate-command.ts";
import { resultLabel, type GateResult } from "./gate-result.ts";
import { logGuardEvent, readGuardLog } from "./guard-log.ts";
import { backgroundWorkers } from "./lead-state.ts";
import { readTicketMarker } from "./ticket-worktree.ts";
import { clearDeliverySnapshot, recordDeliverySnapshot } from "./delivery-snapshot.ts";
import {
  blockedLabel, HANDOFF_PUBLISHED_LABEL, trackerRaw, trackerRefusal, waitingLabel, type BoardStatus, type Tracker,
} from "./tracker.ts";

export const BOARD_GUARD = "board";
const PENDING_RELATIVE = ".bounded/board-pending.json";
const STATE_RELATIVE = ".bounded/board.json";

/** One board update, recorded so a failed one can be replayed in order. */
export type BoardOp =
  | { readonly op: "comment"; readonly issue: number; readonly body: string }
  | { readonly op: "status"; readonly issue: number; readonly status: BoardStatus }
  | { readonly op: "add-label"; readonly issue: number; readonly label: string }
  | { readonly op: "remove-label"; readonly issue: number; readonly label: string }
  | { readonly op: "close"; readonly issue: number };

/** The Status a milestone pass earns. */
export const MILESTONE_STATUS: Readonly<Partial<Record<GateMilestone, BoardStatus>>> = {
  "design-frozen": "Building",
  delivered: "Awaiting Merge",
};

function applyOp(tracker: Tracker, op: BoardOp): void {
  switch (op.op) {
    case "comment": return tracker.comment(op.issue, op.body);
    case "status": return tracker.setStatus(op.issue, op.status);
    case "add-label": return tracker.addLabel(op.issue, op.label);
    case "remove-label": return tracker.removeLabel(op.issue, op.label);
    case "close": return tracker.close(op.issue);
  }
}

/** A pending update, with how many times it failed while the tracker answered. */
export type PendingOp = BoardOp & { readonly attempts?: number };

/** An update that kept failing while the tracker answered, set aside. */
export interface QuarantinedOp {
  readonly op: BoardOp;
  readonly attempts: number;
  readonly error: string;
  readonly at: string;
}

/** After this many failures with the tracker answering, an update is quarantined. */
export const MAX_BOARD_ATTEMPTS = 3;
const QUARANTINE_RELATIVE = ".bounded/board-quarantine.json";

function readList<T>(path: string): T[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? (raw as T[]) : [];
  } catch {
    return [];
  }
}

/** Write a whole file at once: readers see the old list or the new one. */
function writeList(path: string, list: readonly unknown[]): void {
  if (list.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
  renameSync(tmp, path);
}

export function pendingOps(cwd: string): readonly PendingOp[] {
  return readList<PendingOp>(join(cwd, PENDING_RELATIVE));
}

export function quarantinedOps(cwd: string): readonly QuarantinedOp[] {
  return readList<QuarantinedOp>(join(cwd, QUARANTINE_RELATIVE));
}

/** Set quarantined updates aside for good, or put them back to be tried again. */
export function releaseQuarantine(cwd: string, retry: boolean): number {
  const path = join(cwd, QUARANTINE_RELATIVE);
  const held = readList<QuarantinedOp>(path);
  if (held.length === 0) return 0;
  rmSync(path, { force: true });
  if (retry) restorePending(cwd, held.map((q) => q.op));
  return held.length;
}

/**
 * Claim the pending updates by renaming the file away: a gate in the
 * worktree and the lead replaying it can never both take the same updates.
 * A claim left by a process that has gone is adopted.
 */
function claimPending(cwd: string): { readonly ops: PendingOp[]; readonly files: string[] } {
  const dir = join(cwd, ".bounded");
  const files: string[] = [];
  const ops: PendingOp[] = [];
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const orphan = /^board-pending\.claim-([0-9]+)-/.exec(name);
    if (orphan === null || systemProcesses.startTime(Number(orphan[1])) !== undefined) continue;
    files.push(join(dir, name));
    ops.push(...readList<PendingOp>(join(dir, name)));
  }
  const claim = join(dir, `board-pending.claim-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    renameSync(join(cwd, PENDING_RELATIVE), claim);
    files.push(claim);
    ops.push(...readList<PendingOp>(claim));
  } catch {
    // Nothing pending, or another process claimed it first.
  }
  return { ops, files };
}

/** Put updates back in front of any pending since they were claimed. */
function restorePending(cwd: string, ops: readonly PendingOp[]): void {
  if (ops.length === 0) return;
  const since = claimPending(cwd);
  writeList(join(cwd, PENDING_RELATIVE), [...ops, ...since.ops]);
  for (const file of since.files) rmSync(file, { force: true });
}

function quarantine(cwd: string, op: PendingOp, attempts: number, error: unknown): void {
  const path = join(cwd, QUARANTINE_RELATIVE);
  const { attempts: _drop, ...bare } = op;
  writeList(path, [...readList<QuarantinedOp>(path), {
    op: bare as BoardOp, attempts, error: error instanceof Error ? error.message : String(error), at: new Date().toISOString(),
  }]);
}

const answers = (tracker: Tracker): boolean => {
  try {
    tracker.check();
    return true;
  } catch {
    return false;
  }
};

/**
 * Apply `ops` after any still pending, in order. On a failure the failed
 * update and every one after it stay pending, and the error is thrown —
 * unless the tracker answers and the update has now failed
 * MAX_BOARD_ATTEMPTS times: then it is quarantined (`bounded lead status`
 * reports it) and the rest go on, so one bad update cannot block the board.
 */
export function applyBoardOps(cwd: string, tracker: Tracker, ops: readonly BoardOp[]): void {
  const claimed = claimPending(cwd);
  const queue: PendingOp[] = [...claimed.ops, ...ops];
  try {
    for (let i = 0; i < queue.length; i++) {
      const op = queue[i]!;
      try {
        applyOp(tracker, op);
      } catch (error) {
        const reachable = answers(tracker);
        const attempts = (op.attempts ?? 0) + (reachable ? 1 : 0);
        if (reachable && attempts >= MAX_BOARD_ATTEMPTS) {
          quarantine(cwd, op, attempts, error);
          continue;
        }
        restorePending(cwd, [{ ...op, attempts }, ...queue.slice(i + 1)]);
        throw error;
      }
    }
  } finally {
    for (const file of claimed.files) rmSync(file, { force: true });
  }
}

/** Replay pending updates and prove the tracker answers; throws otherwise. */
export function boardReady(cwd: string, tracker: Tracker): void {
  applyBoardOps(cwd, tracker, []);
  tracker.check();
}

interface BoardState {
  /** The blocked label each gate left, cleared by that gate's next pass. */
  readonly blocked: Readonly<Record<string, string>>;
}

function readState(cwd: string): BoardState {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, STATE_RELATIVE), "utf8")) as BoardState;
    return raw !== null && typeof raw.blocked === "object" ? raw : { blocked: {} };
  } catch {
    return { blocked: {} };
  }
}

/** The role a refusal names: its detail's route, else the `route → <role>`
 *  line every gate prints with one. */
export function routeOf(result: GateResult): string | undefined {
  const detail = result.detail["route"];
  if (typeof detail === "string" && /^[a-z][a-z-]*$/.test(detail)) return detail;
  for (const line of result.lines) {
    const match = /route → ([a-z][a-z-]*)/.exec(line);
    if (match !== null) return match[1];
  }
  return undefined;
}

/** The updates one gate result calls for, and the blocked labels after it.
 *  A RUNNING result (ADR 2026-073) posts one comment when its run starts or
 *  restarts and nothing while it is polled; it never moves a label or status. */
export function boardOpsFor(
  issue: number,
  gate: { readonly name: string; readonly milestone?: GateMilestone },
  result: GateResult,
  state: BoardState,
  context: { readonly role?: string; readonly waiting?: () => readonly number[] } = {},
): { readonly ops: readonly BoardOp[]; readonly state: BoardState } {
  if (result.code === 3) {
    const job = result.detail["job"];
    return {
      ops: job === "started" || job === "restarted" ? [{ op: "comment", issue, body: `\`${gate.name}\`: RUNNING — ${result.summary}` }] : [],
      state,
    };
  }
  const ops: BoardOp[] = [{ op: "comment", issue, body: `\`${gate.name}\`: ${resultLabel(result)} — ${result.summary}` }];
  const blocked = { ...state.blocked };
  const previous = blocked[gate.name];
  if (result.code === 0) {
    if (previous !== undefined && !Object.entries(blocked).some(([g, l]) => g !== gate.name && l === previous)) {
      ops.push({ op: "remove-label", issue, label: previous });
    }
    delete blocked[gate.name];
    const status = gate.milestone !== undefined ? MILESTONE_STATUS[gate.milestone] : undefined;
    if (status !== undefined) ops.push({ op: "status", issue, status });
    if (gate.milestone === "handoff-published") {
      ops.push({ op: "add-label", issue, label: HANDOFF_PUBLISHED_LABEL });
      for (const dependent of context.waiting?.() ?? []) {
        ops.push({ op: "remove-label", issue: dependent, label: waitingLabel(issue) });
      }
    }
  } else if (result.code === 1) {
    const route = routeOf(result) ?? context.role ?? "architect";
    const next = blockedLabel(route);
    if (previous !== undefined && previous !== next &&
        !Object.entries(blocked).some(([g, l]) => g !== gate.name && l === previous)) {
      ops.push({ op: "remove-label", issue, label: previous });
    }
    ops.push({ op: "add-label", issue, label: next });
    blocked[gate.name] = next;
  }
  return { ops, state: { blocked } };
}

function refusal(gate: string, reason: string): GateResult {
  return {
    code: 2, verdict: "error",
    summary: `${BOARD_GUARD}: ${reason}`,
    lines: [`${gate}: ${BOARD_GUARD}: ${reason}`, `${gate}: route → user`],
    detail: { route: "user", board: "unsynced" },
  };
}

/**
 * Run a gate with the board kept in step. Outside a ticket worktree the gate
 * simply runs. `open` opens the installation's tracker; `role` is the seat
 * running the gate, the route a refusal without one goes back to.
 */
export async function runGateWithBoard(
  cwd: string,
  gate: { readonly name: string; readonly milestone?: GateMilestone },
  run: () => Promise<GateResult>,
  open: (cwd: string) => Tracker,
  role?: string,
): Promise<GateResult> {
  const marker = readTicketMarker(cwd);
  if (marker === undefined) return run();
  // A worker resumed in the background may still be writing: no gate judges
  // or freezes a tree that is still changing (ADR 2026-066).
  const busy = backgroundWorkers(readGuardLog(cwd)).map((w) => w.worker);
  if (busy.length > 0) {
    return {
      code: 2, verdict: "error",
      summary: `${gate.name} did not run: worker ${busy.join(", ")} is still running in the background`,
      lines: [`${gate.name}: worker ${busy.join(", ")} is still running in the background; wait for it to stop, then run ${gate.name} again`, `${gate.name}: route → architect`],
      detail: { route: "architect", workers: busy },
    };
  }
  let tracker: Tracker;
  try {
    tracker = open(cwd);
    boardReady(cwd, tracker);
  } catch (error) {
    const reason = trackerRefusal(error);
    logGuardEvent(cwd, { guard: BOARD_GUARD, verdict: "block", summary: `${gate.name} refused: ${reason}`, detail: { gate: gate.name, route: "user", raw: trackerRaw(error) } });
    return refusal(gate.name, `${gate.name} did not run: ${reason}`);
  }
  const result = await run();
  // A delivered pass is evidence about exactly this tree; merge takes no other.
  // A run still working in the background is no evidence either way.
  if (gate.milestone === "delivered" && result.code !== 3) {
    try {
      if (result.code === 0) recordDeliverySnapshot(cwd);
      else clearDeliverySnapshot(cwd);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return refusal(gate.name, `${gate.name} ran, but what it delivered could not be recorded (${why}); the board was not updated`);
    }
  }
  try {
    const { ops, state } = boardOpsFor(marker.issue, gate, result, readState(cwd), {
      ...(role !== undefined ? { role } : {}),
      waiting: () => tracker.issuesWithLabel(waitingLabel(marker.issue)),
    });
    writeFileSync(join(cwd, STATE_RELATIVE), JSON.stringify(state, null, 2) + "\n");
    applyBoardOps(cwd, tracker, ops);
    return result;
  } catch (error) {
    const reason = trackerRefusal(error);
    logGuardEvent(cwd, { guard: BOARD_GUARD, verdict: "error", summary: `${gate.name} ran, but the board was not updated: ${reason}`, detail: { gate: gate.name, route: "user", raw: trackerRaw(error) } });
    return {
      ...result,
      code: 2, verdict: "error",
      summary: `${result.summary} — but the board was not updated: ${reason}`,
      lines: [...result.lines, `${gate.name}: ${BOARD_GUARD}: the board was not updated; the update is pending — route → user`],
      detail: { ...result.detail, route: "user", board: "pending", gateCode: result.code },
    };
  }
}

/** Whether a directory still owes the board an update. */
export function boardPending(cwd: string): boolean {
  return existsSync(join(cwd, PENDING_RELATIVE));
}
