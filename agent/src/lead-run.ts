// The lead's run boundary (ADR 2026-048): select one ticket for this worktree
// and open, resume or change its run. Every host reaches this through the
// same argument parser, so the accepted shapes cannot drift between them.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logGuardEvent } from "./guard-log.ts";
import { hasRunStart, isLeadOwnEntry, isProjectLocalHarness, LEAD_GUARD, readRunLog } from "./lead-state.ts";
import { ACTIVE_TICKET_RELATIVE, readActiveTicketFile, TICKET_NUMBER } from "./ticket-design.ts";

/** The one spelling of the command, shared by the CLI, the hosts and the docs. */
export const LEAD_PREPARE_USAGE = "bounded lead prepare [--new] [ticket-number]";

export interface LeadPrepareRequest {
  /** Start a new work item rather than continuing the active one. */
  readonly fresh: boolean;
  /** A tracker issue number; absent allocates the next local number. */
  readonly ticket?: string;
}

export type LeadPrepareArgs =
  | ({ readonly ok: true } & LeadPrepareRequest)
  | { readonly ok: false; readonly reason: string };

/** `[--new] [ticket-number]`, and nothing else. */
export function parseLeadPrepareArgs(args: readonly string[]): LeadPrepareArgs {
  const fresh = args[0] === "--new";
  const rest = fresh ? args.slice(1) : args;
  const ticket = rest[0];
  if (rest.length > 1 || (ticket !== undefined && !TICKET_NUMBER.test(ticket))) {
    return { ok: false, reason: `usage: ${LEAD_PREPARE_USAGE}` };
  }
  return { ok: true, fresh, ...(ticket !== undefined ? { ticket } : {}) };
}

export type LeadPrepareResult =
  | { readonly ok: true; readonly kind: "first" | "change" | "resume"; readonly ticket: string; readonly summary: string }
  | { readonly ok: false; readonly reason: string };

/** One more than every ticket number this worktree already uses. */
export function nextLocalTicket(cwd: string): string {
  const used = new Set<number>();
  const tnDir = join(cwd, "docs", "tn");
  if (existsSync(tnDir)) for (const entry of readdirSync(tnDir)) {
    const match = /^TN-([1-9][0-9]*)\.md$/.exec(entry);
    if (match) used.add(Number(match[1]));
  }
  const ticketDir = join(cwd, ".bounded", "tickets");
  if (existsSync(ticketDir)) for (const entry of readdirSync(ticketDir)) {
    if (TICKET_NUMBER.test(entry)) used.add(Number(entry));
  }
  const active = readActiveTicketFile(cwd);
  if (active.kind === "selected") used.add(Number(active.ticket));
  const next = Math.max(0, ...used) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("no safe local ticket number remains");
  return String(next);
}

const fail = (reason: string): LeadPrepareResult => ({ ok: false, reason: `team-lead: ${reason}` });

function manifestExists(cwd: string, ticket: string): boolean {
  return existsSync(join(cwd, ".bounded", "tickets", ticket, "contract-checksums.json"));
}

/** Archive a delivered run's log, snapshotting `ticket`'s delivered design. */
function openChangeBoundary(cwd: string, ticket: string): string | undefined {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "bounded-change-run");
  try {
    execFileSync("bash", [script, cwd], {
      cwd,
      env: { ...process.env, BOUNDED_TICKET: ticket },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Prepare one ticket in one project worktree. The lead owns this boundary. */
export function prepareLeadRun(cwd: string, requestedTicket?: string, fresh = false): LeadPrepareResult {
  if (!isProjectLocalHarness(cwd)) return fail("no project-local Bounded installation");
  const active = readActiveTicketFile(cwd);
  if (active.kind === "invalid") return fail(active.reason);
  const previous = active.kind === "selected" ? active.ticket : undefined;
  let ticket: string;
  try {
    ticket = requestedTicket ?? (fresh || previous === undefined ? nextLocalTicket(cwd) : previous);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!TICKET_NUMBER.test(ticket)) return fail("ticket must be a positive number");
  if (fresh && previous === ticket) return fail(`ticket #${ticket} is already active; omit --new to change or resume it`);
  const override = process.env["BOUNDED_TICKET"];
  if (override !== undefined && override !== "" && override !== ticket) {
    return fail(`BOUNDED_TICKET selects #${override}; use that ticket or clear the override`);
  }
  if (!existsSync(join(cwd, "docs", "tn", "README.md"))) return fail("this project has no ticket-numbered design notes");

  const switching = previous !== undefined && previous !== ticket;
  if (switching && !fresh) return fail(`ticket #${previous} is active; use a new work item after its final delivery`);

  const log = readRunLog(cwd);
  if (log.kind === "malformed") return fail("guard log is malformed; boundary not changed");
  // The target's own frozen design decides whether this is its first run or a change to it.
  const targetFrozen = manifestExists(cwd, ticket);
  let kind: "first" | "change" | "resume";
  if (log.kind === "absent") {
    // The log is only ever moved aside at a boundary, after final delivery.
    kind = targetFrozen ? "change" : "first";
  } else if (log.state === "delivered") {
    // Snapshot the design about to change; for a new design, the one just delivered.
    const boundary = targetFrozen ? ticket : previous ?? ticket;
    if (!manifestExists(cwd, boundary)) return fail(`delivered log has no frozen design for ticket #${boundary}`);
    const error = openChangeBoundary(cwd, boundary);
    if (error !== undefined) return fail(`change boundary failed: ${error}`);
    kind = targetFrozen ? "change" : "first";
  } else if (switching) {
    return fail("the active ticket has no final delivery; continue it before starting a new work item");
  } else if (hasRunStart(log.entries)) {
    kind = "resume";
  } else if (log.entries.some((entry) => !isLeadOwnEntry(entry))) {
    return fail("unfinished run evidence exists; resume or resolve it before starting another ticket");
  } else {
    kind = targetFrozen ? "change" : "first";
  }

  if (previous !== ticket) writeFileSync(join(cwd, ACTIVE_TICKET_RELATIVE), `${ticket}\n`);
  const summary = `team-lead: ${kind} run prepared for ticket #${ticket}`;
  logGuardEvent(cwd, { guard: LEAD_GUARD, verdict: "pass", summary, detail: { kind: "run-prepared", ticket, boundary: kind } });
  return { ok: true, kind, ticket, summary };
}
