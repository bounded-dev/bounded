// Where each ticket's work lives (ADR 2026-066). The lead stays in the main
// worktree; `bounded lead start` gives every ticket its own git worktree and
// branch, nested under the main worktree's ignored `.bounded/` so that each
// host's project trust and every hidden-directory rule already cover it. The
// ticket worktree carries a marker naming its ticket, which only the start
// command writes (no role may write `.bounded/`), and the main worktree keeps a
// record of every started ticket until it is merged.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Ticket worktrees, under the main worktree. */
export const TICKET_WORKTREES_RELATIVE = ".bounded/worktrees";
/** The marker inside a ticket worktree. */
export const TICKET_MARKER_RELATIVE = ".bounded/ticket-worktree.json";
/** The main worktree's record of started tickets. */
export const LEAD_TICKETS_RELATIVE = ".bounded/lead/tickets";

export const ticketBranch = (issue: number): string => `ticket/${issue}`;
export const ticketWorktreePath = (main: string, issue: number): string => join(main, TICKET_WORKTREES_RELATIVE, String(issue));

export interface TicketMarker {
  readonly issue: number;
  readonly branch: string;
  /** The main worktree this ticket merges back into. */
  readonly main: string;
}

/** The ticket a worktree belongs to, when `cwd` is a ticket worktree's root. */
export function readTicketMarker(cwd: string): TicketMarker | undefined {
  const path = join(cwd, TICKET_MARKER_RELATIVE);
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (raw === null || typeof raw !== "object") return undefined;
    const { issue, branch, main } = raw as Record<string, unknown>;
    if (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue < 1) return undefined;
    if (typeof branch !== "string" || typeof main !== "string") return undefined;
    return { issue, branch, main };
  } catch {
    return undefined;
  }
}

export function isTicketWorktree(cwd: string): boolean {
  return readTicketMarker(cwd) !== undefined;
}

export function writeTicketMarker(worktree: string, marker: TicketMarker): void {
  mkdirSync(join(worktree, ".bounded"), { recursive: true });
  writeFileSync(join(worktree, TICKET_MARKER_RELATIVE), JSON.stringify(marker, null, 2) + "\n");
}

export interface StartedTicket {
  readonly issue: number;
  readonly title: string;
  readonly branch: string;
  readonly worktree: string;
  readonly owns: readonly string[];
  readonly startedAt: string;
}

export function writeStartedTicket(main: string, record: StartedTicket): void {
  const dir = join(main, LEAD_TICKETS_RELATIVE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.issue}.json`), JSON.stringify(record, null, 2) + "\n");
}

export function removeStartedTicket(main: string, issue: number): void {
  rmSync(join(main, LEAD_TICKETS_RELATIVE, `${issue}.json`), { force: true });
}

export function readStartedTicket(main: string, issue: number): StartedTicket | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(main, LEAD_TICKETS_RELATIVE, `${issue}.json`), "utf8")) as StartedTicket;
    return typeof raw.issue === "number" && Array.isArray(raw.owns) && typeof raw.worktree === "string" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Every ticket started from `main` and not yet merged, by issue number. */
export function startedTickets(main: string): readonly StartedTicket[] {
  const dir = join(main, LEAD_TICKETS_RELATIVE);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => /^([1-9][0-9]*)\.json$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => readStartedTicket(main, Number(m[1])))
    .filter((t): t is StartedTicket => t !== undefined)
    .sort((a, b) => a.issue - b.issue);
}
