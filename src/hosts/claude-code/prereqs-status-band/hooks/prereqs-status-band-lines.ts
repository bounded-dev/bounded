// What the prereqs status band draws (ADR 2026-027), pure: the freshness rule
// and the lines, from a status file the band has read and the one value it
// keeps, when it last saw a finished tool call or agent run. It never shows a
// stale status as current: only a fresh read snapshot draws a status mark
// (✓ holds, ◷ pending, ✗ stale, · missing or matching no file), and every
// other line says why there is none.
import { STATUS_FILE, type StatusFile, type StatusFileReading, type StatusFileRequirement, type StatusFileRule } from "./prereqs-status-file";

/** How long after a finish the band waits for bounded's reading of it before saying the status is unavailable: above bounded's 20-second hook deadline. */
export const READING_WAIT_MS = 30_000;

/** Whether a reading is the one after the last finish the band saw. */
export type Freshness = "no-reading-yet" | "fresh" | "updating" | "unavailable";

/** The band's one value, and the time now, both from $.clock in milliseconds. */
export interface Timing {
  /** When the band last saw a finished tool call or agent run; undefined or null when it has seen none. */
  readonly lastFinishSeenAt: number | null | undefined;
  readonly now: number;
}

/**
 * The freshness rule: before any finish the band saw, there is no reading of
 * this session yet; a reading begun at or after the last finish is fresh;
 * one begun before it is updating for 30 s, then unavailable.
 */
export function freshnessOf({ readingStartedAt, lastFinishSeenAt, now }: Timing & { readonly readingStartedAt: string }): Freshness {
  if (lastFinishSeenAt === undefined || lastFinishSeenAt === null) return "no-reading-yet";
  if (Date.parse(readingStartedAt) >= lastFinishSeenAt) return "fresh";
  return now - lastFinishSeenAt <= READING_WAIT_MS ? "updating" : "unavailable";
}

/** A status that cannot be shown, and why: one line, no mark. */
export const unavailableLines = (why: string): string[] => [`prereqs status unavailable: ${why}`];

/** The status file is not there. */
export const missingFileLines = (): string[] => unavailableLines(`no status file at ${STATUS_FILE}: is bounded/prereqs selected, and bounded's Claude Code hook installed?`);

/** The status file is there but could not be read. */
export const unreadableLines = (message: string): string[] => unavailableLines(`${STATUS_FILE} cannot be read: ${message}`);

/** The status file was written for another project than the session's. */
export const otherProjectLines = (projectRoot: string, sessionRoot: string): string[] => unavailableLines(`this status is for ${projectRoot}, not ${sessionRoot}`);

/** The band itself failed while drawing. */
export const drawFailedLines = (message: string): string[] => unavailableLines(`the band could not draw: ${message}`);

/** A time as the band shows it: HH:MM:SS UTC. */
const clockTime = (iso: string): string => `${new Date(iso).toISOString().slice(11, 19)} UTC`;

function requirementLine(requirement: StatusFileRequirement): string {
  const { requiredAgent, unchangedSince, status, filesMatched, pendingRun } = requirement;
  const patterns = unchangedSince.join(", ");
  if (filesMatched === 0) return `· ${requiredAgent}  ${patterns} match no file yet`;
  if (status === "holds") return `✓ ${requiredAgent}  over ${patterns} as they are now`;
  if (status === "pending") return `◷ ${requiredAgent}  running since ${pendingRun === null ? "an unknown time" : clockTime(pendingRun.startedAt)}`;
  if (status === "stale") return `✗ ${requiredAgent}  stale: ${patterns} changed since`;
  return `· ${requiredAgent}  not yet run`;
}

/** The action a rule comes before, in the words bounded/prereqs's describeBefore uses. */
function actionOf(rule: StatusFileRule): string {
  const { before } = rule;
  if ("delegate" in before) return `delegating to ${before.delegate}`;
  if ("write" in before) return `writing ${before.write}`;
  return `executing ${before.execute}`;
}

/** The rules in contribution order up to and including the first that is blocked, each with its requirement's agent and whether it holds. */
function nextLine(file: StatusFile & { readonly outcome: "read" }): string {
  if (file.rules.length === 0) return "bounded/prereqs has no rules in this project";
  const blocked = file.rules.findIndex((rule) => !rule.allows);
  if (blocked === -1) return "→ nothing is blocked";
  const shown = file.rules.slice(0, blocked + 1).map((rule) => {
    const agent = file.requirements.find((requirement) => requirement.key === rule.requirementKey)?.requiredAgent ?? rule.requirementKey;
    return `${actionOf(rule)} needs ${agent} ${rule.allows ? "✓" : "✗"}`;
  });
  return `→ next: ${shown.join("   ")}`;
}

/** What the band draws for a status file it has read (or refused), given when it last saw a finish. */
export function statusLines(reading: StatusFileReading, timing: Timing): string[] {
  if (!reading.ok) return unavailableLines(reading.why);
  const file = reading.value;
  const freshness = freshnessOf({ ...timing, readingStartedAt: file.readingStartedAt });
  if (freshness === "no-reading-yet") return ["prereqs status: no reading yet this session; it comes with the first finished tool call"];
  if (freshness === "updating") return ["prereqs status updating: waiting for bounded's reading of the last call"];
  if (freshness === "unavailable") return unavailableLines("the last reading predates the last finished call, and bounded's hook wrote no newer one");
  if (file.outcome === "unread") return unavailableLines(file.why);
  return [`prereqs status as of ${clockTime(file.readingStartedAt)}`, ...file.requirements.map(requirementLine), nextLine(file)];
}
