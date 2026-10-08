// Host declaration — which capability constraints the running host enforces
// (ADR 2026-034).
//
// Artifact gates answer the same whatever runs them; capability constraints
// (the tool strip, the path gate, the phase gate on spawns, the role-scoped
// worker views) only hold where a host cooperates. A run therefore has to
// say WHICH host it ran under and what that host enforced, or a `bounded gates`
// transcript from a bare shell reads exactly like a blind run: same gates,
// same verdicts, no blindness at all. The declaration is one guard-log event,
// written by the host adapter as the session binds a role (pi: `session_start`;
// Claude Code: the first hook call) and by the CLI when nothing declared
// before it. It is recorded on CHANGE, not once: a bare `bounded gates` before a
// pi session starts records `none`, and the session then records `pi`, so
// the log tells the truth about every stretch of the run.
//
// Pure apart from the one logging call, which reuses the guard log's own
// never-throw boundary.

import { logGuardEvent, readGuardLog } from "./guard-log.ts";

/** The hosts the harness knows how to bind. `none` is a bare shell. */
export type HostName = "pi" | "claude-code" | "none";

/** The capability constraints the developer stage relies on. */
export type Constraint = "tool-strip" | "path-gate" | "phase-gate" | "scoped-views";

/** Every constraint, in the order a person reads them. */
export const CONSTRAINTS: readonly Constraint[] = [
  "tool-strip",
  "path-gate",
  "phase-gate",
  "scoped-views",
];

export interface HostDeclaration {
  readonly host: HostName;
  readonly enforced: readonly Constraint[];
  readonly unenforced: readonly Constraint[];
}

/** The guard name the declaration is logged under. */
export const HOST_GUARD = "host";

/** Env a host adapter sets on a gate process it launches, naming itself —
 *  the CLI records `none` unless this names a host. A person exporting
 *  `BOUNDED_DEV_STAGE_ROLE` alone to see a role's view is not a host. */
export const HOST_ENV = "BOUNDED_HOST";

/** Parse the env value; anything but a known host is no host. */
export function hostFromEnv(value: string | undefined): HostName | undefined {
  return value === "pi" || value === "claude-code" ? value : undefined;
}

/** Env a host adapter sets on a gate process it launches: how long, in
 *  milliseconds, the host lets this command run before it kills it. A gate
 *  that can split its work across calls (the mutation measurement) keeps
 *  each call inside it. Unset means the host gives no deadline. */
export const COMMAND_TIMEOUT_ENV = "BOUNDED_COMMAND_TIMEOUT_MS";

/** The host's command deadline in ms, or undefined when none is set or the
 *  value is not a positive integer: a deadline nobody can read is none. */
export function commandTimeoutMs(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const raw = env[COMMAND_TIMEOUT_ENV];
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The share of a host's command deadline one call may spend on its own work,
 *  leaving the larger of 15% and 15 s to release what it started and report
 *  (ADR 2026-070, ADR 2026-072). Undefined when the host gives no deadline. */
export function callBudgetMs(deadlineMs: number | undefined): number | undefined {
  if (deadlineMs === undefined) return undefined;
  return Math.max(0, deadlineMs - Math.max(Math.ceil(deadlineMs * 0.15), 15_000));
}

/** Build a declaration; `unenforced` is derived so the two lists can never disagree. */
export function declareHost(host: HostName, enforced: readonly Constraint[]): HostDeclaration {
  const held = new Set(enforced);
  return {
    host,
    enforced: CONSTRAINTS.filter((c) => held.has(c)),
    unenforced: CONSTRAINTS.filter((c) => !held.has(c)),
  };
}

/** A bare shell: gates only, nothing constrained. */
export const NO_HOST: HostDeclaration = declareHost("none", []);

/** The one-line summary the log carries. */
export function hostSummary(d: HostDeclaration): string {
  const enforced = d.enforced.length ? d.enforced.join(", ") : "nothing";
  return d.unenforced.length
    ? `host ${d.host}: enforces ${enforced}; unenforced: ${d.unenforced.join(", ")}`
    : `host ${d.host}: enforces ${enforced}`;
}

/** The most recent declaration in the log, if any. */
export function lastHostDeclaration(cwd: string): HostDeclaration | undefined {
  const events = readGuardLog(cwd);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.guard !== HOST_GUARD) continue;
    const detail = e.detail;
    if (detail === undefined) return undefined;
    const host = detail["host"];
    const enforced = detail["enforced"];
    if (!isHostName(host) || !isConstraintList(enforced)) return undefined;
    return declareHost(host, enforced);
  }
  return undefined;
}

/**
 * Record the declaration unless the log's latest one already says the same.
 * Returns whether a line was written, so a host can mention it once.
 */
export function recordHostDeclaration(cwd: string, d: HostDeclaration): boolean {
  const last = lastHostDeclaration(cwd);
  if (last !== undefined && sameDeclaration(last, d)) return false;
  logGuardEvent(cwd, {
    guard: HOST_GUARD,
    verdict: "pass",
    summary: hostSummary(d),
    detail: { kind: "host", host: d.host, enforced: d.enforced, unenforced: d.unenforced },
  });
  return true;
}

function sameDeclaration(a: HostDeclaration, b: HostDeclaration): boolean {
  return a.host === b.host && a.enforced.join(",") === b.enforced.join(",");
}

function isHostName(v: unknown): v is HostName {
  return v === "pi" || v === "claude-code" || v === "none";
}

function isConstraintList(v: unknown): v is readonly Constraint[] {
  return Array.isArray(v) && v.every((c) => (CONSTRAINTS as readonly unknown[]).includes(c));
}
