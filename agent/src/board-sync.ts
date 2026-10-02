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

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateMilestone } from "./gate-command.ts";
import type { GateResult } from "./gate-result.ts";
import { logGuardEvent } from "./guard-log.ts";
import { readTicketMarker } from "./ticket-worktree.ts";
import { clearDeliverySnapshot, recordDeliverySnapshot } from "./delivery-snapshot.ts";
import {
  blockedLabel, HANDOFF_PUBLISHED_LABEL, trackerRefusal, waitingLabel, type BoardStatus, type Tracker,
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

export function pendingOps(cwd: string): readonly BoardOp[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(cwd, PENDING_RELATIVE), "utf8"));
    return Array.isArray(raw) ? (raw as BoardOp[]) : [];
  } catch {
    return [];
  }
}

function savePending(cwd: string, ops: readonly BoardOp[]): void {
  if (ops.length === 0) rmSync(join(cwd, PENDING_RELATIVE), { force: true });
  else writeFileSync(join(cwd, PENDING_RELATIVE), JSON.stringify(ops, null, 2) + "\n");
}

/**
 * Apply `ops` after any still pending, in order. On the first failure the
 * failed update and every one after it stay pending, and the error is thrown.
 */
export function applyBoardOps(cwd: string, tracker: Tracker, ops: readonly BoardOp[]): void {
  const queue = [...pendingOps(cwd), ...ops];
  for (let i = 0; i < queue.length; i++) {
    try {
      applyOp(tracker, queue[i]!);
    } catch (error) {
      savePending(cwd, queue.slice(i));
      throw error;
    }
  }
  savePending(cwd, []);
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

/** The updates one gate result calls for, and the blocked labels after it. */
export function boardOpsFor(
  issue: number,
  gate: { readonly name: string; readonly milestone?: GateMilestone },
  result: GateResult,
  state: BoardState,
  context: { readonly role?: string; readonly waiting?: () => readonly number[] } = {},
): { readonly ops: readonly BoardOp[]; readonly state: BoardState } {
  const label = result.code === 0 ? "PASS" : result.code === 1 ? "BLOCK" : "ERROR";
  const ops: BoardOp[] = [{ op: "comment", issue, body: `\`${gate.name}\`: ${label} — ${result.summary}` }];
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
  let tracker: Tracker;
  try {
    tracker = open(cwd);
    boardReady(cwd, tracker);
  } catch (error) {
    const reason = trackerRefusal(error);
    logGuardEvent(cwd, { guard: BOARD_GUARD, verdict: "block", summary: `${gate.name} refused: ${reason}`, detail: { gate: gate.name, route: "user" } });
    return refusal(gate.name, `${gate.name} did not run: ${reason}`);
  }
  const result = await run();
  // A delivered pass is evidence about exactly this tree; merge takes no other.
  if (gate.milestone === "delivered") {
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
    logGuardEvent(cwd, { guard: BOARD_GUARD, verdict: "error", summary: `${gate.name} ran, but the board was not updated: ${reason}`, detail: { gate: gate.name, route: "user" } });
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
