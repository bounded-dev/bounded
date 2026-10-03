// pi's gate for a ticket's architect seat (hosts/pi/architect-seat.ts, ADR
// 2026-066). The lead may start an architect only as the one pending
// ticket's — an async pi-subagents child whose `cwd` is that ticket's worktree
// — and continue one only with the pending reply. pi lets a tool_call hook
// rewrite the call's input in place, so the call that runs carries exactly
// the brief, the worktree and the reply the lead's commands prepared.
//
// The architect child records its own start and end (its per-role loader runs
// in the child process, in the worktree), which also releases the pending
// launch: recordArchitectSeatLife below.

import {
  claimPendingLaunch, clearPendingLaunch, clearPendingReply, readArchitectState, readPendingLaunch, readPendingReply,
  recordArchitectEnded, recordArchitectRunning, writePendingLaunch,
} from "../../../../src/architect-seat.ts";
import { systemProcesses } from "../../../../src/process-lock.ts";
import { readTicketMarker } from "../../../../src/ticket-worktree.ts";

type Input = Record<string, unknown>;
export type SeatCall = { readonly handled: false } | { readonly handled: true; readonly refuse?: string };

const LAUNCH_FIELDS: ReadonlySet<string> = new Set(["agent", "task", "cwd", "async", "agentScope", "model", "action", "subagent_type"]);
const RESUME_FIELDS: ReadonlySet<string> = new Set(["action", "id", "message"]);
const extraField = (input: Input, allowed: ReadonlySet<string>): string | undefined =>
  Object.keys(input).find((key) => input[key] !== undefined && !allowed.has(key));

/** A lead `subagent` call that starts or continues an architect, judged and rewritten. */
export function leadArchitectCall(input: Input, toolCallId: string, main: string): SeatCall {
  const action = input["action"];
  if (input["agent"] === "architect" && (action === undefined || action === "launch" || action === "run")) {
    const extra = extraField(input, LAUNCH_FIELDS);
    if (extra !== undefined) return { handled: true, refuse: `team-lead: an architect launch carries only its role, worktree and background running ('${extra}' is not allowed)` };
    const claimed = claimPendingLaunch(main, toolCallId);
    if ("error" in claimed) return { handled: true, refuse: `team-lead: ${claimed.error}` };
    for (const key of Object.keys(input)) delete input[key];
    Object.assign(input, {
      agent: "architect", task: claimed.brief, cwd: claimed.worktree, async: true, agentScope: "project",
      ...(claimed.model !== undefined ? { model: claimed.model } : {}),
    });
    return { handled: true };
  }
  if (action === "resume") {
    const extra = extraField(input, RESUME_FIELDS);
    if (extra !== undefined) return { handled: true, refuse: `team-lead: an architect continuation carries only its id and the reply ('${extra}' is not allowed)` };
    const pending = readPendingReply(main);
    if (pending === undefined || pending.agent !== input["id"]) {
      return { handled: true, refuse: "team-lead: only a reply prepared with bounded lead reply <issue> <message> continues an architect" };
    }
    if (readArchitectState(pending.worktree)?.state === "running") return { handled: true, refuse: `team-lead: #${pending.issue}'s architect is still running` };
    input["message"] = pending.message;
    clearPendingReply(main);
    return { handled: true };
  }
  return { handled: false };
}

/** A lead architect launch that failed releases its claim, so the lead can launch again. */
export function afterLeadArchitectCall(input: Input, toolCallId: string, isError: boolean, main: string): void {
  if (!isError || input["agent"] !== "architect") return;
  const pending = readPendingLaunch(main);
  if (pending?.claimedBy === toolCallId) {
    const { claimedBy: _released, ...open } = pending;
    writePendingLaunch(main, open);
  }
}

/** The architect child's own life, recorded in its ticket worktree by its loader. */
export function recordArchitectSeatLife(cwd: string, phase: "start" | "end"): void {
  const marker = readTicketMarker(cwd);
  if (marker === undefined) return;
  const agent = process.env["PI_SUBAGENT_RUN_ID"] ?? `pi-${process.pid}`;
  if (phase === "end") {
    recordArchitectEnded(cwd, agent);
    return;
  }
  recordArchitectRunning(cwd, agent, { pid: process.pid, pidStarted: systemProcesses.startTime(process.pid) ?? "unknown" });
  if (readPendingLaunch(marker.main)?.issue === marker.issue) clearPendingLaunch(marker.main);
}
