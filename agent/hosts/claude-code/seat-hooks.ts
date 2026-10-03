// Claude Code's hooks for a ticket's architect seat (architect-seat.ts, ADR
// 2026-066): binding the lead's background architect launch to the pending
// ticket, routing the subagent's calls to its worktree, recording its end, and
// letting the lead continue exactly the architect a reply was prepared for.
//
// All of it is evidence Claude Code reports in the hook input — the call's
// `cwd`, the subagent's `agent_id`, the WorktreeCreate `name` (which carries
// the new agent's id) — checked against state only the lead's commands write.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  claimPendingLaunch, clearPendingLaunch, clearPendingReply, readArchitectState, readPendingLaunch, readPendingReply,
  recordArchitectEnded, recordArchitectRunning, writePendingLaunch,
} from "../../src/architect-seat.ts";
import { logGuardEvent } from "../../src/guard-log.ts";
import { LEAD_GUARD } from "../../src/lead-state.ts";
import { systemProcesses } from "../../src/process-lock.ts";
import { readTicketMarker, TICKET_MARKER_RELATIVE, ticketWorktreeDirs } from "../../src/ticket-worktree.ts";
import { sendTarget } from "./continuation.ts";
import { allowWith, deny, type HookPayload } from "./hook-output.ts";

/** The ticket worktree a call's `cwd` lies in: the nearest directory upward
 *  that carries a ticket marker. Undefined outside every ticket worktree. */
export function ticketRootOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  let dir: string;
  try {
    dir = realpathSync(cwd);
  } catch {
    return undefined;
  }
  for (;;) {
    if (existsSync(join(dir, TICKET_MARKER_RELATIVE)) && readTicketMarker(dir) !== undefined) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** The Claude Code process this hook runs for (its nearest `claude`
 *  ancestor), with its start time: a seat whose session died is never running. */
export function sessionProcess(): { readonly pid: number; readonly pidStarted: string } {
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const run = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
    const match = /^\s*(\d+)\s+(.*)$/.exec((run.stdout ?? "").trim());
    if (match === null) break;
    if (/(^|\/)claude$/.test(match[2]!.trim())) return { pid, pidStarted: systemProcesses.startTime(pid) ?? "unknown" };
    pid = Number(match[1]);
  }
  return { pid: process.ppid, pidStarted: systemProcesses.startTime(process.ppid) ?? "unknown" };
}

/** The fields the lead's architect launch may carry; the hook supplies the rest. */
const LAUNCH_FIELDS: ReadonlySet<string> = new Set(["subagent_type", "prompt", "description", "model", "isolation", "run_in_background"]);

/**
 * The lead's Agent call for an architect: allowed only as the launch of the
 * one pending ticket, rewritten to carry exactly its brief, its model, worktree
 * isolation and background running.
 */
export function leadArchitectLaunch(payload: HookPayload, main: string): string {
  const refuse = (reason: string): string => {
    logGuardEvent(main, { guard: LEAD_GUARD, verdict: "block", summary: reason, detail: { host: "claude-code", kind: "architect-launch" } });
    return deny(reason);
  };
  const extra = Object.keys(payload.toolInput).find((key) => payload.toolInput[key] !== undefined && !LAUNCH_FIELDS.has(key));
  if (extra !== undefined) return refuse(`team-lead: an architect launch carries only its role, worktree isolation and background running ('${extra}' is not allowed)`);
  if (payload.toolUseId === undefined) return refuse("team-lead: this host gave the architect launch no call id, so it cannot be bound to its ticket");
  const claimed = claimPendingLaunch(main, payload.toolUseId);
  if ("error" in claimed) return refuse(`team-lead: ${claimed.error}`);
  logGuardEvent(main, {
    guard: LEAD_GUARD, verdict: "pass", summary: `team-lead: launching #${claimed.issue}'s architect`,
    detail: { host: "claude-code", kind: "architect-launch", issue: claimed.issue, call: payload.toolUseId },
  });
  return allowWith({
    subagent_type: "architect",
    description: `Architect for ticket #${claimed.issue}`,
    prompt: claimed.brief,
    isolation: "worktree",
    run_in_background: true,
    ...(claimed.model !== undefined ? { model: claimed.model } : {}),
  });
}

/**
 * WorktreeCreate: Claude Code is about to create the isolation worktree for
 * the lead's architect launch. Answer with the claimed ticket's existing
 * worktree, and bind the new agent (its id is in the event's `name`) to it.
 * Anything else gets no worktree, and the launch fails.
 */
export function onWorktreeCreate(rec: Readonly<Record<string, unknown>>, main: string): { readonly stdout: string; readonly stderr: string; readonly exit: number } {
  const fail = (why: string) => {
    logGuardEvent(main, { guard: LEAD_GUARD, verdict: "block", summary: `team-lead: no worktree: ${why}`, detail: { host: "claude-code", kind: "worktree-create" } });
    return { stdout: "", stderr: `bounded: ${why}\n`, exit: 1 };
  };
  const name = typeof rec["name"] === "string" ? rec["name"] : "";
  const agent = /^agent-(a[0-9a-f]{8,64})$/.exec(name)?.[1];
  if (agent === undefined) return fail(`'${name}' is not an agent's worktree; only an architect launch gets one`);
  const pending = readPendingLaunch(main);
  if (pending?.claimedBy === undefined) return fail("no architect launch is under way; run bounded lead start <issue> first");
  const marker = readTicketMarker(pending.worktree);
  if (marker?.issue !== pending.issue) return fail(`ticket #${pending.issue}'s worktree is not marked as its own`);
  recordArchitectRunning(pending.worktree, agent, sessionProcess());
  clearPendingLaunch(main);
  logGuardEvent(main, {
    guard: LEAD_GUARD, verdict: "pass", summary: `team-lead: #${pending.issue}'s architect is ${agent}, in its worktree`,
    detail: { host: "claude-code", kind: "architect-bound", issue: pending.issue, agent },
  });
  return { stdout: `${pending.worktree}\n`, stderr: "", exit: 0 };
}

/** The lead's Agent call for its architect failed before binding: release the claim. */
export function afterLeadArchitectCall(payload: HookPayload, main: string): void {
  if (payload.event !== "PostToolUseFailure") return;
  const pending = readPendingLaunch(main);
  if (pending?.claimedBy !== undefined && pending.claimedBy === payload.toolUseId) {
    const { claimedBy: _released, ...open } = pending;
    writePendingLaunch(main, open);
  }
}

/** SubagentStop: the architect bound to the stopping agent's worktree has ended. */
export function onSubagentStop(rec: Readonly<Record<string, unknown>>): void {
  const agent = typeof rec["agent_id"] === "string" ? rec["agent_id"] : undefined;
  const root = ticketRootOf(typeof rec["cwd"] === "string" ? rec["cwd"] : undefined);
  if (agent === undefined || root === undefined) return;
  recordArchitectEnded(root, agent);
}

/**
 * The lead's SendMessage: allowed only as the one pending reply, to the
 * architect it was prepared for, carrying exactly that reply. The seat is
 * running again from here.
 */
export function leadReplySend(payload: HookPayload, main: string): string {
  const refuse = (reason: string): string => {
    logGuardEvent(main, { guard: LEAD_GUARD, verdict: "block", summary: reason, detail: { host: "claude-code", kind: "architect-reply" } });
    return deny(reason);
  };
  const target = sendTarget(payload.toolInput);
  if (!target.ok) return refuse(`team-lead: ${target.reason}`);
  const pending = readPendingReply(main);
  if (pending === undefined) return refuse("team-lead: no reply is waiting; prepare one with bounded lead reply <issue> <message>");
  if (pending.agent !== target.to) return refuse(`team-lead: the waiting reply is for #${pending.issue}'s architect ${pending.agent}, not ${target.to}`);
  const state = readArchitectState(pending.worktree);
  if (state?.agent !== pending.agent || state.state === "running") {
    return refuse(`team-lead: #${pending.issue}'s architect is not waiting for a reply`);
  }
  recordArchitectRunning(pending.worktree, pending.agent, sessionProcess());
  clearPendingReply(main);
  return allowWith({ to: pending.agent, message: pending.message });
}

/** After the lead's SendMessage: a continuation that did not go through ends the turn again. */
export function afterLeadReply(payload: HookPayload, rec: Readonly<Record<string, unknown>>, main: string): void {
  const response = rec["tool_response"];
  const ok = payload.event === "PostToolUse" && typeof response === "object" && response !== null &&
    (response as Record<string, unknown>)["success"] === true;
  if (ok) return;
  const to = payload.toolInput["to"];
  if (typeof to !== "string") return;
  for (const root of ticketWorktreeDirs(main)) recordArchitectEnded(root, to);
}
