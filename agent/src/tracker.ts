// The tracker port (ADR 2026-066): what the team lead's commands and the gates
// need from an issue tracker, in the harness's own words. The core names no
// tracker: an adapter under trackers/ translates these calls to one, and the
// installation's committed `.bounded/tracker.json` says which adapter and
// which repository and board it serves. Roles never reach a tracker; only
// these commands and the gates do.
//
// Every call is synchronous and throws a TrackerError when the tracker cannot
// be reached or refuses. A caller turns that into a refusal routed to the
// user, so the board and the worktree never silently disagree.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The board's Status values, exactly, in the order work moves through them. */
export const BOARD_STATUSES = ["Backlog", "Queued", "In Design", "Building", "Awaiting Merge", "Done"] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export function isBoardStatus(value: unknown): value is BoardStatus {
  return typeof value === "string" && (BOARD_STATUSES as readonly string[]).includes(value);
}

/** Where an installation records its tracker: committed, so every worktree has it. */
export const TRACKER_CONFIG_RELATIVE = ".bounded/tracker.json";

/** The label a refused gate leaves, naming the role the work went back to. */
export const BLOCKED_LABEL_PREFIX = "blocked: ";
export const blockedLabel = (route: string): string => `${BLOCKED_LABEL_PREFIX}${route}`;
/** The label a queued ticket carries while a dependency's design is not handed off. */
export const WAITING_LABEL_PREFIX = "waiting on #";
export const waitingLabel = (issue: number): string => `${WAITING_LABEL_PREFIX}${issue}`;
/** The label a producer carries once its design handoff is published. */
export const HANDOFF_PUBLISHED_LABEL = "handoff published";

export interface TrackerIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
  /** The issue's Status on the installation's board, when it is on it. */
  readonly status?: BoardStatus;
}

export interface Tracker {
  /** Throws unless the tracker is reachable and the session may write to it. */
  check(): void;
  createIssue(title: string, body: string): { readonly number: number; readonly url: string };
  viewIssue(issue: number): TrackerIssue;
  /** Put the issue on the board (idempotent) and set its Status. */
  setStatus(issue: number, status: BoardStatus): void;
  addLabel(issue: number, label: string): void;
  removeLabel(issue: number, label: string): void;
  /** Open issues carrying `label`. */
  issuesWithLabel(label: string): readonly number[];
  comment(issue: number, body: string): void;
  close(issue: number): void;
}

/** The tracker could not be reached, or refused the call. */
export class TrackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackerError";
  }
}

/** The reason every refused command and gate gives when the tracker fails. */
export function trackerRefusal(error: unknown): string {
  const why = error instanceof Error ? error.message : String(error);
  return `the tracker is unreachable or refused (${why.slice(0, 400)}); nothing was changed on the board — route → user`;
}

export interface TrackerConfig {
  /** Which adapter under trackers/ serves this installation. */
  readonly kind: string;
  /** The adapter's own settings, opaque to the core. */
  readonly settings: Readonly<Record<string, unknown>>;
}

/** The installation's tracker, or a reason it has none usable. */
export function readTrackerConfig(cwd: string): TrackerConfig | { readonly error: string } {
  const path = join(cwd, TRACKER_CONFIG_RELATIVE);
  if (!existsSync(path)) {
    return { error: `this installation records no tracker (${TRACKER_CONFIG_RELATIVE}); initialize it with a tracker first` };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const { kind, ...settings } = parsed as Record<string, unknown>;
    if (typeof kind !== "string" || kind === "") throw new Error("no 'kind'");
    return { kind, settings };
  } catch (error) {
    return { error: `${TRACKER_CONFIG_RELATIVE} is malformed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
