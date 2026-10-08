// Gate result — the one contract every artifact gate answers in (ADR LEG-2026-034).
//
// A gate inspects the tree and says one of three things: PASS (code 0), BLOCK
// (code 1, the gate ran and said no), or ERROR (code 2, the gate itself could
// not run — misuse, nothing matched, a broken target). A fourth answer, RUNNING
// (code 3), is never a gate's own: only the harness's background runner gives
// it, through `gateRunning`, when a long gate's run outlasts the host's call
// and the next call with the same arguments collects it (ADR LEG-2026-073). That triple was already
// the exit-code convention of every pack script, but the SHAPE around it was
// declared four separate times (red-gate, design-gate, sign-off, design-review)
// and the trailing verdict line the architect reads lived only in the pi
// extension. A CLI, a pi tool and a second host's hook must all print and
// parse the same thing, so the shape and its rendering live here, once, in the
// language-agnostic core: packs produce it, hosts consume it.
//
// Pure: no I/O, no logging. The guard-log boundary stays where each gate
// already has it.

import type { GuardVerdict } from "./guard-log.ts";

/** 0 PASS · 1 BLOCK · 2 ERROR (misuse — the gate could not run) · 3 RUNNING
 *  (still working in the background; only `gateRunning` builds it). Also the
 *  exit code. */
export type GateCode = 0 | 1 | 2 | 3;

export interface GateResult {
  readonly code: GateCode;
  /** The guard-log vocabulary for the same verdict: pass | block | error | running. */
  readonly verdict: GuardVerdict;
  /** One greppable line — what the guard log records. */
  readonly summary: string;
  /** Greppable output lines, in the order a person reads them. */
  readonly lines: readonly string[];
  /** Structured evidence for the guard log and for `--json` consumers. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/** The verdict as the human-facing label. */
export type GateVerdictLabel = "PASS" | "BLOCK" | "ERROR" | "RUNNING";

/** The bare `{code, lines}` shape several pack runners still return. */
export interface BareGateRun {
  readonly code: number;
  readonly lines: readonly string[];
}

/** The JSON object `bounded gates --json` prints: the result plus the gate's name
 *  and the route it named, if any, lifted out of `detail` because a consumer
 *  bouncing work to a role should not have to know the detail's layout. */
export interface GateEnvelope {
  readonly gate: string;
  readonly verdict: GuardVerdict;
  readonly code: GateCode;
  readonly summary: string;
  readonly lines: readonly string[];
  readonly detail: Readonly<Record<string, unknown>>;
  readonly route: string | null;
}

/** Clamp a runner's numeric exit code onto the contract: anything that is not
 *  0 or 1 is "the gate could not run" — a runner's own 3 included, because
 *  RUNNING is the harness's answer, never a gate's. */
export function gateCodeOf(code: number): 0 | 1 | 2 {
  return code === 0 ? 0 : code === 1 ? 1 : 2;
}

/** The guard-log verdict for a code. */
export function guardVerdictOf(code: number): GuardVerdict {
  const c = gateCodeOf(code);
  return c === 0 ? "pass" : c === 1 ? "block" : "error";
}

/** The human label for a code. */
export function gateVerdictOf(code: number): GateVerdictLabel {
  const c = gateCodeOf(code);
  return c === 0 ? "PASS" : c === 1 ? "BLOCK" : "ERROR";
}

/**
 * The trailing line every gate's output ends with — the one the architect
 * reads, so its wording is pinned here rather than in any one host. ERROR
 * explains itself because a model reading "ERROR" otherwise hunts for a
 * defect in the project when the defect is in the invocation.
 */
export function verdictLine(name: string, code: number): string {
  const label = gateVerdictOf(code);
  return label === "ERROR"
    ? `${name}: ERROR (misuse — the gate could not run)`
    : `${name}: ${label}`;
}

/** The label a result carries: RUNNING for the background runner's answer,
 *  otherwise its code's. */
export function resultLabel(result: GateResult): GateVerdictLabel {
  return result.code === 3 ? "RUNNING" : gateVerdictOf(result.code);
}

/** The trailing line for a result. RUNNING says what to do about it, for
 *  the same reason ERROR explains itself. */
export function resultVerdictLine(name: string, result: GateResult): string {
  return result.code === 3
    ? `${name}: RUNNING (still working in the background; call ${name} again to collect it)`
    : verdictLine(name, result.code);
}

/** What a RUNNING answer says about the run behind it. `job` is whether this
 *  call started it, restarted it, or found it still running. */
export interface RunningRun {
  readonly startedAt: string;
  readonly job: "started" | "restarted" | "running";
  readonly pid: number;
  /** Why a run was restarted (`dead`, `args-changed`, `tree-changed`, …). */
  readonly reason?: string;
  /** Anything the caller should know about the wait (another host, a cancel). */
  readonly note?: string;
}

const RESTART_WHY: Readonly<Record<string, string>> = {
  dead: "its earlier run stopped without a result",
  "timed-out": "its earlier run outlived its time limit",
  "args-changed": "it was called with different arguments",
  "tree-changed": "the project's files changed after its earlier run",
  "packs-changed": "its earlier run used another copy of the harness",
};

/**
 * The background runner's answer: the gate's run is still working. Only the
 * harness's job mechanism calls this (src/gate-jobs.ts); a gate that returns
 * code 3 itself is turned into an ERROR.
 */
export function gateRunning(name: string, run: RunningRun): GateResult {
  const what = run.job === "started"
    ? `started in the background at ${run.startedAt}`
    : run.job === "restarted"
      ? `restarted in the background at ${run.startedAt}${run.reason !== undefined ? ` (${RESTART_WHY[run.reason] ?? run.reason})` : ""}`
      : `still running in the background (started ${run.startedAt})`;
  const summary = `${name} ${what}`;
  return {
    code: 3,
    verdict: "running",
    summary,
    lines: [`${name}: ${what}`, ...(run.note !== undefined ? [`${name}: ${run.note}`] : [])],
    detail: {
      job: run.job, pid: run.pid, startedAt: run.startedAt,
      ...(run.reason !== undefined ? { reason: run.reason } : {}),
      ...(run.note !== undefined ? { note: run.note } : {}),
    },
  };
}

/** The process exit code a result maps to. Named so a host never re-derives it. */
export function gateExitCode(result: GateResult): GateCode {
  return result.code;
}

/**
 * Lift a bare `{code, lines}` run onto the contract. The summary is the first
 * non-empty line with the gate's own `<name>: ` prefix removed — the runners
 * that return this shape already put their one-line verdict first — or the
 * label when there is nothing to quote.
 */
export function toGateResult(
  name: string,
  run: BareGateRun,
  detail: Readonly<Record<string, unknown>> = {},
): GateResult {
  const code = gateCodeOf(run.code);
  const first = run.lines.find((l) => l.trim() !== "");
  const prefix = `${name}: `;
  const summary =
    first === undefined
      ? gateVerdictOf(code)
      : first.startsWith(prefix)
        ? first.slice(prefix.length)
        : first;
  return { code, verdict: guardVerdictOf(code), summary, lines: [...run.lines], detail };
}

/** The `--json` envelope for a result. */
export function gateEnvelope(name: string, result: GateResult): GateEnvelope {
  const route = result.detail["route"];
  return {
    gate: name,
    verdict: result.verdict,
    code: result.code,
    summary: result.summary,
    lines: result.lines,
    detail: result.detail,
    route: typeof route === "string" ? route : null,
  };
}

/**
 * A gate that could not run — bad invocation, a thrown runner — as a result
 * in the same shape as any other, so a `--json` consumer never parses a
 * stack trace. `reason` is the machine-readable cause in `detail`.
 */
export function gateError(name: string, message: string, reason: string): GateResult {
  return {
    code: 2,
    verdict: "error",
    summary: message,
    lines: [`${name}: ERROR — ${message}`],
    detail: { reason },
  };
}
