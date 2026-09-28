// run_tests custom tool core (TN-26-001, §"Custom tools" #3).
//
// The builder subagent is blind to test SOURCE but must see failure output to
// debug. run_tests runs the project's vitest suite with the JSON reporter and
// pipes stdout through the ALREADY-BUILT sanitizer (sanitizeTestRun) — the
// only thing that ever reaches the builder is the sanitizer's whitelist:
// test name, status, and a source-scrubbed assertion diff. Same suite binary
// as the orchestrator's gates (vitest), different reporter.
//
// This module owns spawning + shaping; sanitization is NOT reimplemented here.
// The command runner is injectable so the logic is unit-testable against the
// sanitizer's real captured fixtures without spawning vitest.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import {
  SanitizeError,
  type SanitizedResult,
  sanitizeMessage,
  sanitizeTestRun,
} from "./sanitize-test-output.ts";
import { logGuardEvent, readGuardLog } from "../../../src/guard-log.ts";
import type { GateResult } from "../../../src/gate-result.ts";
import { configDriftBlock, configDriftReason } from "./project-config.ts";

/** Captured output of one command invocation. */
export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/** Runs a command in `cwd` and resolves with its captured output (never
 *  rejects on a non-zero exit — a failing suite is expected). */
export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<CommandOutput>;

export interface RunTestsOptions {
  /** Override the command runner (tests inject a fake). */
  readonly run?: CommandRunner;
  /** Override the vitest invocation. Default: `npx vitest run --reporter=json`. */
  readonly command?: string;
  readonly args?: string[];
}

/** Per-status tally over the sanitized results. */
export interface RunSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** skipped + todo + pending — anything that didn't execute to a verdict. */
  readonly skipped: number;
}

export interface RunTestsResult extends RunSummary {
  /** True when the suite ran, no test failed, AND no unhandled error escaped. */
  readonly ok: boolean;
  /** Sanitized per-test outcomes, in reporter order. */
  readonly results: SanitizedResult[];
  /** Present ONLY when vitest produced no parseable JSON report (BLOCKED): a
   *  sanitized (path-scrubbed) explanation drawn from stderr/stdout. */
  readonly blocked?: string;
  /** Present when the suite ran to a report in which every assertion passed but
   *  the process still exited non-zero — an UNHANDLED error (a throw outside any
   *  assertion: an async rejection, or a throw inside an event handler or effect
   *  during a test). Vitest does not count these among `assertionResults`, so a
   *  runner that only tallies pass/fail would call this run green. It is not.
   *  The value is a FIXED, source-free explanation — never the raw error text,
   *  which can carry test source — so surfacing it does not widen what a blind
   *  builder can see. */
  readonly unhandled?: string;
}

/**
 * The blind-safe note surfaced when a suite exits non-zero with every assertion
 * passing — an unhandled error (dogfood Run 29). FIXED text: it names the
 * failure CLASS and nothing about the test that raised it, because the raw error
 * (message, stack, the identifier that threw) is test source the builder must
 * not see. "Green is a positive claim" — a suite that leaked an error did not
 * make it.
 */
export const UNHANDLED_ERROR_NOTE =
  "the suite raised an unhandled error — a throw outside any assertion (an async " +
  "rejection, or a throw inside an event handler or effect during a test). Every " +
  "assertion passed, but the run exited non-zero, so the suite did not pass. Vitest " +
  "reports this as an UNHANDLED error, not a failed assertion.";

/**
 * Did a parsed run leak an unhandled error? The robust in-band signal is the
 * process exit: vitest exits non-zero on an unhandled error even when every
 * assertion passed, so `failed === 0` AND a non-zero exit AND tests that
 * actually ran is exactly that shape. A failing suite exits non-zero too but
 * reports `failed > 0`, so it is not caught here; a suite that produced no
 * report at all is the `blocked` path and never reaches this.
 */
export function hasUnhandledError(code: number | null, failed: number, ran: number): boolean {
  return code !== 0 && failed === 0 && ran > 0;
}

const DEFAULT_COMMAND = "npx";
// The default args carry `--exclude` for the harness's own scratch space:
// `.bounded/**` must never be collected by the project's suite. The red gate
// rebuilds a SHADOW project at `.bounded/shadow-red/` (red-gate.ts) whose tests are
// copies of the project's own, running against regenerated skeletons — and
// vitest globs test files with `dot: true` while its default exclude covers
// only node_modules and .git. Without the flag every live run would collect
// the shadow's copies too, and every one of them would fail with
// NotImplementedError. The flag is ADDITIVE in vitest (`cliExclude`), so the
// built-in excludes still apply.
const DEFAULT_ARGS = ["vitest", "run", "--reporter=json", "--exclude=**/.bounded/**"];

/** Default runner: spawn, capture stdout/stderr, resolve on close.
 *
 *  Exported so a caller that needs the real spawn PLUS something runTests does
 *  not itself expose can compose it — mutation-score wraps it with an
 *  AbortSignal to bound each mutant's suite run. Rejects if the signal aborts. */
export const spawnRunner: CommandRunner = (command, args, cwd, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });

/**
 * Extract the reporter's JSON object from captured stdout. Vitest's JSON
 * reporter emits one top-level object; other runners/plugins occasionally
 * bracket it with log noise, so slice from the first `{` to the last `}`.
 */
export function extractReporterJson(stdout: string): string {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return stdout.trim();
  return stdout.slice(start, end + 1);
}

const isSkip = (status: string) =>
  status === "skipped" || status === "todo" || status === "pending";

export function summarizeResults(results: readonly SanitizedResult[]): RunSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "passed") passed++;
    else if (r.status === "failed") failed++;
    else if (isSkip(r.status)) skipped++;
  }
  return { total: results.length, passed, failed, skipped };
}

/**
 * Run the project's vitest suite (JSON reporter) in `cwd` and return the
 * sanitized, blind-safe view. Never throws for an ordinary failing suite;
 * an unparseable run is reported via {@link RunTestsResult.blocked}.
 */
export async function runTests(cwd: string, options: RunTestsOptions = {}): Promise<RunTestsResult> {
  // The test runner loads the project's config as code: refuse to spawn it
  // over config the composed packs did not generate (ADR 2026-054).
  const drift = configDriftReason(cwd);
  if (drift !== undefined) return { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, results: [], blocked: drift };
  const run = options.run ?? spawnRunner;
  const command = options.command ?? DEFAULT_COMMAND;
  const args = options.args ?? DEFAULT_ARGS;

  const { stdout, stderr, code } = await run(command, args, cwd);

  let results: SanitizedResult[];
  try {
    results = sanitizeTestRun(extractReporterJson(stdout));
  } catch (e) {
    if (e instanceof SanitizeError) {
      // The suite could not even produce a report (config/import error, crash).
      // Surface a sanitized, path-free explanation — never the raw stderr.
      const raw = stderr.trim() !== "" ? stderr : stdout;
      const blocked = sanitizeMessage(raw) || `vitest exited with code ${code ?? "null"} and no JSON report`;
      return { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, results: [], blocked };
    }
    throw e;
  }

  const summary = summarizeResults(results);
  const unhandled = hasUnhandledError(code, summary.failed, results.length)
    ? UNHANDLED_ERROR_NOTE
    : undefined;
  return {
    ok: summary.failed === 0 && unhandled === undefined,
    ...summary,
    results,
    ...(unhandled !== undefined ? { unhandled } : {}),
  };
}

// --- convergence detection (dogfood Run 4) -----------------------------------
// Blindness has one failure mode the builder cannot escape from the inside:
// when it disagrees with a test it cannot read, it will re-derive the same
// wrong answer forever. In Run 4 the builder ran the suite three times on the
// same two failures and burned ~15 minutes inferring expectations from
// spec.md before deciding to dispute. The dispute protocol existed; nothing
// invoked it.
//
// run_tests is the builder's only channel, so the nudge belongs here. It
// reveals nothing about test source — only that convergence has stopped, and
// which protocol to follow. One retry is normal, so the third identical run
// is the first that trips it.

const STUCK_THRESHOLD = 3;

/** Failing test names, in reporter order. */
export function failureNames(result: RunTestsResult): string[] {
  return result.results.filter((r) => r.status === "failed").map((r) => r.name);
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

/**
 * Warn when the same failure set has recurred `threshold` times running.
 *
 * `previousFailureSets` is oldest-to-newest. A green run, a changed failure
 * set, or partial progress all reset the streak — the builder is converging
 * and should be left alone. Returns the nudge text, or undefined.
 */
export function repeatedFailureNudge(
  previousFailureSets: readonly (readonly string[])[],
  current: readonly string[],
  threshold: number = STUCK_THRESHOLD,
): string | undefined {
  if (current.length === 0) return undefined; // green: never stuck
  let streak = 1;
  for (let i = previousFailureSets.length - 1; i >= 0; i--) {
    if (!sameSet(previousFailureSets[i]!, current)) break;
    streak++;
  }
  if (streak < threshold) return undefined;
  const n = current.length;
  return [
    `run_tests: this is the ${ordinal(streak)} consecutive run with the same ${n} failing test${n === 1 ? "" : "s"} — you are not converging.`,
    "You are blind to test source by design and cannot read tests/ (the path gate will refuse it), so re-reading the spec again is unlikely to break the tie.",
    "Follow the dispute protocol now: return DISPUTE naming the failing tests, the spec clause you implemented and your reading of it, and your best-guess fix.",
  ].join("\n");
}

/** Human-readable, blind-safe rendering of a run for the tool's text output. */
export function formatRunTests(result: RunTestsResult): string {
  if (result.blocked !== undefined) {
    return `run_tests: suite could not run (BLOCKED):\n\n${result.blocked}`;
  }
  const head = `Tests: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (${result.total} total)`;
  const parts = [head];
  if (result.failed > 0) {
    parts.push(
      result.results
        .filter((r) => r.status === "failed")
        .map((r) => {
          const body = r.message ? "\n" + r.message.replace(/^/gm, "    ") : "";
          return `✗ ${r.name}${body}`;
        })
        .join("\n\n"),
    );
  }
  // An unhandled error is not a failed assertion, so it never appears above —
  // and a run that only tallied pass/fail would call this green. Say so.
  if (result.unhandled !== undefined) parts.push(`run_tests: UNHANDLED ERROR — ${result.unhandled}`);
  return parts.join("\n\n");
}

// --- the gate (ADR 2026-034) ----------------------------------------------------
// The builder's tool and the `bounded gates run-tests` command are the same call.
// This is the guard-log boundary for the suite run: the event is what the
// convergence nudge reads back, so writing it anywhere but next to the nudge
// would let a host forget it and quietly switch the nudge off.

/** The guard name of the suite-run event. Spelled like the tool because the
 *  log already carries a history under it (dogfood Run 4 onward). */
export const RUN_TESTS_GUARD = "run_tests";

/** Failing-test-name sets from this project's prior run_tests events, oldest→newest. */
function priorFailureSets(cwd: string): string[][] {
  try {
    return readGuardLog(cwd)
      .filter((e) => e.guard === RUN_TESTS_GUARD)
      .map((e) => {
        const names = e.detail?.["names"];
        return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
      });
  } catch {
    return []; // an unreadable log must never break the builder's only channel
  }
}

/**
 * Run the suite as a gate: the sanitized run, the convergence nudge drawn
 * from this project's prior runs, and one guard event. BLOCK is a failing
 * suite; ERROR is a suite that could not even produce a report.
 */
export async function runTestsGate(cwd: string, options: RunTestsOptions = {}): Promise<GateResult> {
  const configBlock = configDriftBlock(RUN_TESTS_GUARD, cwd);
  if (configBlock !== undefined) return configBlock;
  const result = await runTests(cwd, options);
  const names = failureNames(result);
  // The guard log is the only run history that survives between tool calls,
  // and it is already written on every run — so convergence is measured
  // from the same audit trail the orchestrator reads (dogfood Run 4).
  const nudge = repeatedFailureNudge(priorFailureSets(cwd), names);
  const blocked = result.blocked !== undefined;
  // An unhandled error with no failed assertion is still NOT-green: the suite
  // leaked an error, and green is a positive claim. It blocks like a failure.
  const unhandled = result.unhandled !== undefined && result.failed === 0;
  const green = !blocked && result.failed === 0 && !unhandled;
  const code = blocked ? 2 : green ? 0 : 1;
  const verdict = blocked ? "error" : green ? "pass" : "block";
  const summary = blocked
    ? "suite could not run"
    : unhandled
      ? "suite raised an unhandled error"
      : `${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`;
  logGuardEvent(cwd, {
    guard: RUN_TESTS_GUARD,
    verdict,
    summary,
    detail: { names, ...(unhandled ? { unhandled: true } : {}), ...(nudge !== undefined ? { stuck: true } : {}) },
  });
  const text = nudge === undefined ? formatRunTests(result) : `${formatRunTests(result)}\n\n${nudge}`;
  return {
    code,
    verdict,
    summary,
    lines: text.split("\n"),
    detail: {
      ok: result.ok,
      total: result.total,
      passed: result.passed,
      failed: result.failed,
      skipped: result.skipped,
      blocked,
      stuck: nudge !== undefined,
      names,
    },
  };
}

// --- CLI ------------------------------------------------------------------------

// Symlink-safe main check (invoked via the ~/.pi/agent symlink): compare realpaths.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runTests(process.argv[2] ?? process.cwd()).then(
    (result) => {
      console.log(formatRunTests(result));
      process.exit(result.ok ? 0 : 1);
    },
    (e: unknown) => {
      console.error(`run_tests: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
