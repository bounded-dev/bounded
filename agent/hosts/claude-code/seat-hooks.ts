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
  claimPendingLaunch, clearPendingLaunch, clearPendingReply, pendingReplyFor, readPendingLaunch, recordArchitectEnded,
  architectStatus, recordArchitectRunning, releaseLaunchClaim, seatContinuable, seatNeedsRelaunch,
} from "../../src/architect-seat.ts";
import { logGuardEvent } from "../../src/guard-log.ts";
import { LEAD_GUARD, SUBAGENT_STOPPED } from "../../src/lead-state.ts";
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

/** Whether a process (its executable and command line) is Claude Code: the
 *  native build (`claude`, or `…/claude/versions/<version>`) or the npm build
 *  (node running `@anthropic-ai/claude-code` or a `claude` script). */
export function isClaudeProcess(comm: string, args: string): boolean {
  const exe = comm.trim();
  if (/(^|\/)claude$/.test(exe) || /\/claude\/versions\/[^/]+$/.test(exe)) return true;
  return /(^|\/)node$/.test(exe) && /(@anthropic-ai\/claude-code|(^|[\s/])claude(\s|$))/.test(args);
}

/**
 * The Claude Code process this hook runs for (its nearest Claude Code
 * ancestor), with its start time, so a seat whose session died is never
 * reported running. When none is found the start time is "unknown": the seat
 * is then never judged lost, rather than tied to this short-lived hook.
 */
export function sessionProcess(
  read: (pid: number) => { readonly ppid: number; readonly comm: string; readonly args: string } | undefined = psRow,
): { readonly pid: number; readonly pidStarted: string } {
  let pid = process.ppid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    const row = read(pid);
    if (row === undefined) break;
    if (isClaudeProcess(row.comm, row.args)) return { pid, pidStarted: systemProcesses.startTime(pid) ?? "unknown" };
    pid = row.ppid;
  }
  return { pid: 0, pidStarted: "unknown" };
}

function psRow(pid: number): { readonly ppid: number; readonly comm: string; readonly args: string } | undefined {
  const comm = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
  const match = /^\s*(\d+)\s+(.*)$/.exec((comm.stdout ?? "").trim());
  if (match === null) return undefined;
  const args = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return { ppid: Number(match[1]), comm: match[2]!, args: (args.stdout ?? "").trim() };
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
  const claimed = claimPendingLaunch(main, payload.toolUseId, sessionProcess());
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
  recordArchitectRunning(pending.worktree, agent, { ...sessionProcess(), sessionBound: true });
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
  if (readPendingLaunch(main)?.claimedBy === payload.toolUseId) releaseLaunchClaim(main);
}

/**
 * WorktreeRemove: Claude Code may remove an isolation worktree when its
 * subagent finishes. A ticket's worktree belongs to the ticket until `merge`
 * removes it, so this hook removes nothing; answering it is enough to keep
 * Claude Code's own removal from running.
 */
export function onWorktreeRemove(rec: Readonly<Record<string, unknown>>, main: string): { readonly stdout: string; readonly stderr: string; readonly exit: number } {
  const path = [rec["worktree_path"], rec["path"], rec["cwd"]].find((v): v is string => typeof v === "string");
  logGuardEvent(main, {
    guard: LEAD_GUARD, verdict: "pass", summary: `team-lead: kept ${path ?? "a worktree"}; only bounded lead merge removes a ticket's worktree`,
    detail: { host: "claude-code", kind: "worktree-kept" },
  });
  return { stdout: "", stderr: "", exit: 0 };
}

/** SubagentStop: the architect bound to the stopping agent's worktree has ended. */
export function onSubagentStop(rec: Readonly<Record<string, unknown>>): void {
  const agent = typeof rec["agent_id"] === "string" ? rec["agent_id"] : undefined;
  const root = ticketRootOf(typeof rec["cwd"] === "string" ? rec["cwd"] : undefined);
  if (agent === undefined || root === undefined) return;
  if (recordArchitectEnded(root, agent)) return;
  // A worker's stop: one resumed in the background no longer holds the gates.
  logGuardEvent(root, {
    guard: "phase-gate", verdict: "pass", summary: `subagent ${agent} stopped`,
    detail: { kind: SUBAGENT_STOPPED, agent, ...(typeof rec["agent_type"] === "string" ? { role: rec["agent_type"] } : {}) },
  });
}

/** What the lead does instead of a SendMessage that continues nothing. */
const LEAD_SEND_WAY_FORWARD =
  "a scout is not continued (commission a fresh scout), and an architect is continued once a reply is prepared " +
  "with bounded lead reply <issue> <message>";

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
  if (!target.ok) return refuse(`team-lead: ${target.reason}; ${LEAD_SEND_WAY_FORWARD}`);
  const pending = pendingReplyFor(main, target.to);
  if (pending === undefined) return refuse(`team-lead: no reply is waiting for ${target.to}; ${LEAD_SEND_WAY_FORWARD}`);
  // Only a stopped seat whose session still runs continues; one whose session
  // has gone is relaunched by `bounded lead start` (ADR 2026-066).
  if (!seatContinuable(pending.worktree, pending.agent)) {
    return refuse(seatNeedsRelaunch(architectStatus(pending.worktree))
      ? `team-lead: #${pending.issue}'s architect ran in a session that has ended and cannot be continued; relaunch it with bounded lead start ${pending.issue}`
      : `team-lead: #${pending.issue}'s architect is still running; one architect turn runs per worktree`);
  }
  recordArchitectRunning(pending.worktree, pending.agent, { ...sessionProcess(), sessionBound: true });
  clearPendingReply(main, pending.issue);
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
