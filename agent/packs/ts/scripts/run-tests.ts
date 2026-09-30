// run_tests custom tool core (TN-26-001, §"Custom tools" #3; ADR 2026-062).
//
// The builder subagent is blind to test SOURCE but must see failure output to
// debug. run_tests runs the project's suite with `bun test` and its JUnit
// reporter, and hands the report and the console output to the sanitizer
// (sanitize-test-output.ts). The only thing that ever reaches the builder is
// the sanitizer's whitelist: test name, status, and the error's text with
// every frame, path, console line and quoted test line removed. To make that
// last filter provable rather than heuristic, this module reads every
// test-side file of the project first and passes their lines as forbidden.
//
// This module owns spawning and shaping; sanitization is NOT reimplemented
// here. The command runner is injectable so the logic is unit-testable
// against the real captured reports in testdata/bun-junit/ without spawning.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forbiddenLines,
  SanitizeError,
  type SanitizedResult,
  sanitizeBunRun,
  sanitizeLegacyJsonRun,
  sanitizeMessage,
} from "./sanitize-test-output.ts";
import { logGuardEvent, readGuardLog } from "../../../src/guard-log.ts";
import type { GateResult } from "../../../src/gate-result.ts";
import { hasTestFileSuffix, testFileSuffixes } from "../../../src/pack-contrib.ts";
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
  /** Override the suite invocation. Default: {@link testCommand}. With a
   *  replaced command, the JUnit report may also arrive on stdout. */
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
  /** Sanitized per-test outcomes, in report order; errors raised outside any
   *  test follow as failed results named `(outside any test)`. */
  readonly results: SanitizedResult[];
  /** Present ONLY when the suite produced no readable report (BLOCKED): a
   *  sanitized explanation drawn from the console output. */
  readonly blocked?: string;
  /** Present when the suite ran to a report in which nothing failed but the
   *  process still exited non-zero: an error this module could not attribute
   *  to a test or to an unhandled-error block. The value is FIXED,
   *  source-free text, so surfacing it widens nothing the builder sees. */
  readonly unhandled?: string;
}

/**
 * The blind-safe note surfaced when a suite exits non-zero with every test
 * passing (dogfood Run 29). FIXED text: it names the failure CLASS and nothing
 * about the test that raised it. "Green is a positive claim" — a suite that
 * leaked an error did not make it.
 */
export const UNHANDLED_ERROR_NOTE =
  "the suite raised an unhandled error — a throw outside any assertion (an async " +
  "rejection, or a throw inside an event handler or effect during a test). Every " +
  "test passed, but the run exited non-zero, so the suite did not pass.";

/**
 * Did a parsed run leak an error? The robust in-band signal is the process
 * exit: bun exits non-zero whenever anything failed, so `failed === 0` AND a
 * non-zero exit AND tests that actually ran is exactly that shape. A failing
 * suite exits non-zero too but reports `failed > 0`; a suite that produced no
 * report at all is the `blocked` path and never reaches this.
 */
export function hasUnhandledError(code: number | null, failed: number, ran: number): boolean {
  return code !== 0 && failed === 0 && ran > 0;
}

/** The harness's own scratch space is never collected by a project's suite.
 *  Bun already skips dot-directories while collecting; the flag says so
 *  explicitly, so the red gate's shadow copy (`.bounded/shadow-red/`) can
 *  never be run by a live suite whatever a future bun decides. Running bun
 *  INSIDE the shadow still collects the shadow's own tests (verified). */
export const IGNORE_HARNESS_STATE = "--path-ignore-patterns=**/.bounded/**";

/** The suite invocation: bun's runner with its JUnit reporter into `report`. */
export function testCommand(report: string): { command: string; args: string[] } {
  return { command: "bun", args: ["test", "--reporter=junit", `--reporter-outfile=${report}`, IGNORE_HARNESS_STATE] };
}

/** Default runner: spawn, capture stdout/stderr, resolve on close. Colour is
 *  switched off so the console report is plain text.
 *
 *  Exported so a caller that needs the real spawn PLUS something runTests does
 *  not itself expose can compose it — mutation-score wraps it with an
 *  AbortSignal to bound each mutant's suite run. Rejects if the signal aborts. */
export const spawnRunner: CommandRunner = (command, args, cwd, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      signal,
      shell: process.platform === "win32",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });

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

// Bun's own test-file pattern (`bun test --help`: *.test.*, *.spec.*,
// *_test_*, *_spec_*), so every file bun runs is covered even where no pack
// contributed a suffix, plus the composed test-side suffixes: a support file
// such as `x.store.test-support.ts` is test source too.
const BUN_TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_(?:test|spec)_[^/]*\.[cm]?[jt]sx?)$/i;
const MAX_TEST_SOURCE_BYTES = 16 * 1024 * 1024;

/** The text of every test-side file under `cwd`, in path order (dependency
 *  directories and dot-directories skipped): what the sanitizer must never
 *  let through. */
export function testSources(cwd: string): string[] {
  let suffixes: readonly string[];
  try {
    suffixes = testFileSuffixes(cwd);
  } catch {
    suffixes = [];
  }
  const out: string[] = [];
  let bytes = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && (BUN_TEST_FILE.test(entry.name) || hasTestFileSuffix(entry.name, suffixes))) {
        const size = statSync(path).size;
        if (bytes + size > MAX_TEST_SOURCE_BYTES) continue;
        bytes += size;
        out.push(readFileSync(path, "utf8"));
      }
    }
  };
  walk(cwd);
  return out;
}

/** The report a run left: the JUnit file, or JUnit XML on stdout from a
 *  replaced command. */
function reportOf(report: string, stdout: string): string | undefined {
  if (existsSync(report)) return readFileSync(report, "utf8");
  return stdout.trimStart().startsWith("<") ? stdout : undefined;
}

/**
 * Run the project's suite in `cwd` and return the sanitized, blind-safe view.
 * Never throws for an ordinary failing suite; a run with no readable report
 * is reported via {@link RunTestsResult.blocked}.
 */
export async function runTests(cwd: string, options: RunTestsOptions = {}): Promise<RunTestsResult> {
  // The test runner loads the project's config: refuse to spawn it over
  // config the composed packs did not generate (ADR 2026-054).
  const drift = configDriftReason(cwd);
  if (drift !== undefined) return { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, results: [], blocked: drift };
  const run = options.run ?? spawnRunner;
  const reportDir = mkdtempSync(join(tmpdir(), "bounded-junit-"));
  const report = join(reportDir, "report.xml");
  try {
    const invocation = testCommand(report);
    const command = options.command ?? invocation.command;
    const args = options.args ?? (options.command === undefined ? invocation.args : []);
    const forbidden = forbiddenLines(testSources(cwd));
    const { stdout, stderr, code } = await run(command, args, cwd);
    const xml = reportOf(report, stdout);

    let results: SanitizedResult[];
    try {
      if (xml !== undefined) results = sanitizeBunRun(xml, stderr, forbidden);
      else if (options.command !== undefined && stdout.includes("testResults")) {
        // TRANSITIONAL: a replaced command's canned JSON report (see the end
        // of sanitize-test-output.ts). The default invocation never gets here.
        const start = stdout.indexOf("{");
        const end = stdout.lastIndexOf("}");
        results = sanitizeLegacyJsonRun(start === -1 || end < start ? stdout : stdout.slice(start, end + 1), forbidden);
      } else throw new SanitizeError("no report");
    } catch (e) {
      if (e instanceof SanitizeError) {
        // The suite could not even produce a report (no test files, a crash).
        // Surface a sanitized, path-free explanation — never the raw output.
        const raw = stderr.trim() !== "" ? stderr : stdout;
        const blocked = sanitizeMessage(raw, forbidden) || `the test runner exited with code ${code ?? "null"} and wrote no report`;
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
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
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
    "You are blind to test source by design and cannot read test files (the path gate will refuse it), so re-reading the spec again is unlikely to break the tie.",
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
