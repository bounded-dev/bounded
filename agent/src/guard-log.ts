// Guard log (TN-26-001 progress-log principle: "a deterministic system that
// is opaque when it jams is just a deterministic jam").
//
// Every deterministic guard — path gate, contract-purity, scaffolder,
// red/green gates — appends one JSONL event here, in the TARGET project:
//
//   <project>/.bounded/guard-log.jsonl
//
// Always on (BOUNDED_GUARD_LOG=off opts out): the value is after-the-fact
// inspection of runs you didn't know would be interesting. Blocks show where
// guards caught drift; passes prove the guard actually ran — "no drift" and
// "guard never ran" must never be indistinguishable.
//
// Lives in the harness core (language-agnostic): packs and extensions both
// log through here. Pure cores never log; the wiring layers at the trust
// boundaries do. Best-effort: logging must never break a gate.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GuardVerdict =
  | "pass" // guard ran, nothing wrong
  | "block" // guard stopped something (drift caught)
  | "error"; // guard itself couldn't run (e.g. no files matched)

export interface GuardEvent {
  /** Which guard fired: "contract-purity", "scaffold", "path-gate", "red-gate", … */
  readonly guard: string;
  readonly verdict: GuardVerdict;
  /** One greppable line. */
  readonly summary: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export type LoggedGuardEvent = GuardEvent & { readonly ts: string };

export const GUARD_LOG_RELATIVE = ".bounded/guard-log.jsonl";

/**
 * The guard name of the run-start marker: the first gated tool call of a
 * session (r15). It lives here because a producer (the path gate, which logs
 * it) and a consumer (phase-durations, which starts the clock at it) must
 * agree on the spelling, and neither should own the other's vocabulary.
 */
export const RUN_START_GUARD = "run-start";

export function guardLogPath(cwd: string): string {
  return join(cwd, GUARD_LOG_RELATIVE);
}

/**
 * Text a host must never write to the log, rewritten before every line is
 * written: a host adapter registers what its own host must keep out (ADR
 * 2026-069). The core names nothing it redacts.
 */
export type GuardLogRedactor = (cwd: string, text: string) => string;
const redactors: GuardLogRedactor[] = [];

export function addGuardLogRedactor(redactor: GuardLogRedactor): void {
  if (!redactors.includes(redactor)) redactors.push(redactor);
}

/** Every string in a value, passed through the registered redactors. */
function redacted(cwd: string, value: unknown): unknown {
  if (typeof value === "string") return redactors.reduce((text, redact) => redact(cwd, text), value);
  if (Array.isArray(value)) return value.map((item) => redacted(cwd, item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redacted(cwd, item)]));
  }
  return value;
}

export function logGuardEvent(cwd: string, event: GuardEvent): void {
  if (process.env["BOUNDED_GUARD_LOG"] === "off") return;
  try {
    const path = guardLogPath(cwd);
    mkdirSync(dirname(path), { recursive: true });
    const clean = redactors.length === 0 ? event : (redacted(cwd, event) as GuardEvent);
    const line: LoggedGuardEvent = { ts: new Date().toISOString(), ...clean };
    appendFileSync(path, JSON.stringify(line) + "\n");
  } catch {
    // Logging must never break a gate.
  }
}

/** Read the log for inspection. Unparseable lines are skipped, not fatal. */
export function readGuardLog(cwd: string): LoggedGuardEvent[] {
  let raw: string;
  try {
    raw = readFileSync(guardLogPath(cwd), "utf8");
  } catch {
    return [];
  }
  const events: LoggedGuardEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as LoggedGuardEvent);
    } catch {
      // partial/corrupt line (crash mid-write, hand edit) — skip
    }
  }
  return events;
}
