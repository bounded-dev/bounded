// green gate (TN-26-001, BUILD verdict, §"Test-runner gates").
//
//   node green-gate.ts [targetDir]
//
// Runs the target project's suite with `bun test` (via the shared run_tests
// runner, ADR LEG-2026-062) AND `bunx tsc`, and asserts GREEN from the
// ORCHESTRATOR's own run — never the builder's say-so (TN-26-001 §"Roles and
// flow": "green is asserted from the orchestrator's own run"). The suite must
// run and every test must pass; any failure fails the gate, naming each
// failing test. A suite that could not run (BLOCKED) or executed no tests is a
// fail: green is a positive claim, and silence is not success.
//
// GREEN ALSO REQUIRES A TYPE-CLEAN PROJECT (issue #7). Dogfood Run 3 declared
// "GREEN (22/22)" while tsc still had two errors in the test file: tests pass
// at RUNTIME while the project does not compile, and the builder could not
// have fixed it anyway (blind to test files, and the path gate refuses the
// edit). So the gate typechecks too and, on failure, prints ONE route line
// naming the furthest-upstream role that may repair what it found — a
// failure only in test-side files bounces to the test-writer.
//
// A SKIPPED TEST IS NOT A PASS. Green refuses any skipped or todo result, and
// the phase test policies (ADR LEG-2026-064) refuse before the suite runs when
// store tests exist and no container runtime answers; the variables that
// would let a store test skip itself are removed from the test process.
// Green also checks the green-only test obligations (an app's smoke test),
// before anything runs (issue #52). What only the user can clear (the
// container engine) routes to the user in product terms (ADR LEG-2026-072).
//
// GREEN IS BOUND TO A RED. Before running anything, the gate requires a
// red-gate pass that is still standing: recorded after the last contract
// freeze, AND made against the tests as they are now. Green runs on the LIVE
// tree (that is what it is for); red runs on a shadow project, so the two
// verdicts are only about the same work if the tests have not moved between
// them. See `redBindingFor`.
//
// Exit 0 green · 1 not green (one greppable line each) · 2 misuse (target
// unrunnable / bad invocation). Logs one guard event to the target's
// .bounded/guard-log.jsonl.
//
// The suite and tsc commands are injectable for testing via BOUNDED_GATE_TEST_CMD /
// BOUNDED_GATE_TEST_ARGS and BOUNDED_GATE_TSC_CMD / BOUNDED_GATE_TSC_ARGS (JSON arrays).

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { GATE_SUITE_TIMEOUT_MS, runTests, type RunTestsResult } from "./run-tests.ts";
import {
  gateOptionsFromEnv,
  gateTypecheckOptionsFromEnv,
  testFilesHash,
} from "./red-gate.ts";
import type { GateResult } from "../../../src/gate-result.ts";
import { typecheck, type TypecheckResult } from "./typecheck.ts";
import { mostUpstream, projectOwnerOf, routeTypecheck, typecheckLines, type FixOwner, type OwnerOf } from "./typecheck-routing.ts";
import { UNREADABLE_LAYOUT, type PathLayout } from "../../../src/path-policy.ts";
import { logGuardEvent, readGuardLog } from "../../../src/guard-log.ts";
import { configDriftBlock } from "./project-config.ts";
import { lintSrc } from "./lint-src.ts";
import { checkProjectSurfaces } from "./surface-check.ts";
import { findSkeletonImports, type SkeletonImporter } from "./skeleton-imports.ts";
import { sourceRoots } from "../../../src/pack-contrib.ts";
import { type PhaseRun, phaseRun, withPreparedServices } from "./phase-policy.ts";
import { projectFactsOf } from "./project-emitters.ts";
import { checkObligations, obligationLines, readObligationInput } from "./test-obligations.ts";

const GUARD = "green-gate";

/** The suite half of the verdict: what went wrong, and who owns it. */
interface SuiteVerdict {
  readonly summary: string;
  readonly lines: string[];
  readonly detail: Readonly<Record<string, unknown>>;
  /** The role a bounce would go to for this failure alone. */
  readonly owner: FixOwner;
}

function suiteVerdict(run: RunTestsResult): SuiteVerdict | null {
  if (run.blocked !== undefined) {
    return {
      summary: "suite did not run",
      lines: [
        "green-gate: FAIL — suite did not run; green must be proven by a real passing run",
        ...run.blocked.split("\n").map((l) => `  ${l}`),
      ],
      detail: { reason: "blocked", blocked: run.blocked },
      // Dispute protocol: BLOCKED (the suite can't run) bounces to the test-writer.
      owner: "test-writer",
    };
  }
  if (run.unhandled !== undefined) {
    // Dogfood Run 29: the suite passed 224/224 while a throw inside an event
    // handler during a test surfaced as an UNHANDLED error — not a failed
    // assertion, so the sanitized runner's pass/fail tally never saw it and
    // green passed. An error the suite leaked is not a positive claim; it
    // blocks, and routes to whoever owns the tests.
    return {
      summary: "suite raised an unhandled error",
      lines: [
        "green-gate: FAIL — the suite raised an unhandled error; every assertion passed but the run " +
          "exited non-zero, so this is not green (silence is not success)",
        `  ${run.unhandled}`,
      ],
      detail: { reason: "unhandled" },
      // Dispute protocol: an error the suite raised (not an assertion) is the
      // test-writer's zone, exactly like a BLOCKED suite.
      owner: "test-writer",
    };
  }
  if (run.total === 0) {
    return {
      summary: "no tests ran",
      lines: ["green-gate: FAIL — no tests ran; green is a positive claim (silence is not success)"],
      detail: { reason: "no-tests" },
      owner: "test-writer",
    };
  }
  const skipped = run.results.filter((r) => r.status !== "passed" && r.status !== "failed");
  if (run.failed === 0 && skipped.length > 0) {
    return {
      summary: `${skipped.length} skipped test${skipped.length === 1 ? "" : "s"}`,
      lines: [
        `green-gate: FAIL — ${skipped.length} test${skipped.length === 1 ? " was" : "s were"} skipped or left todo; a skipped test is not a pass`,
        ...skipped.map((r) => `  not run: ${r.name} (${r.status})`),
        "  Generated laws skip when a value object's contract gives no @accepts examples (the architect's);",
        "  a hand-written skip or todo is the test-writer's.",
      ],
      detail: { reason: "skipped", names: skipped.map((r) => r.name) },
      owner: "test-writer",
    };
  }
  if (run.failed > 0) {
    const failures = run.results.filter((r) => r.status === "failed");
    return {
      summary: `${run.failed} failing test${run.failed === 1 ? "" : "s"}`,
      lines: [
        `green-gate: FAIL — ${run.failed} failing test${run.failed === 1 ? "" : "s"} of ${run.total}`,
        ...failures.map((f) => `  failed: ${f.name}`),
      ],
      detail: { reason: "failures", failed: run.failed, total: run.total, names: failures.map((f) => f.name) },
      // At BUILD, making a frozen suite pass is the builder's job.
      owner: "builder",
    };
  }
  return null;
}

/**
 * Who should fix a failing suite, given what failed last time?
 *
 * A failing test normally means the implementation is wrong, so it routes to
 * the builder. But dogfood Run 6 deadlocked on the opposite case: the test read
 * `invoices[1]` where it needed `invoices[2]`, having copied the index from a
 * sibling test with no renewal step. The implementation was correct.
 *
 * Every part then behaved as specified and the loop still could not escape —
 * the gate routed to the builder, the architect obeyed the route as instructed,
 * and the builder cannot fix a test it is blind to. It respawned the builder
 * and hit the identical failure.
 *
 * Repetition is the evidence, exactly as in the `run_tests` non-convergence
 * nudge: a builder that has failed twice against the SAME set is not making
 * progress, and the test is now the likelier defect. No model judgement is
 * involved — the first block still routes to the builder, and only an identical
 * repeat reroutes.
 */
export function routeAfterRepeat(
  failing: readonly string[],
  priorFailures: readonly (readonly string[])[],
): FixOwner {
  if (failing.length === 0) return "builder";
  const key = (names: readonly string[]) => [...names].sort().join("\u0000");
  const previous = priorFailures[priorFailures.length - 1];
  if (previous !== undefined && key(previous) === key(failing)) return "test-writer";
  return "builder";
}

/**
 * Classify a run against the green-gate contract. Pure: no I/O, no logging.
 * Green requires BOTH a fully passing suite and a type-clean project (#7).
 */
export function classifyGreen(
  run: RunTestsResult,
  tsc: TypecheckResult,
  /** Escape-hatch problems in the builder's source (see lint-src.ts). A `!`, an `as`, an
   *  `any` or a `@ts-expect-error` is the type checker being switched off for
   *  one expression, so it is a gate failure exactly like a type error, never
   *  an advisory note. Always the builder's: it is the builder's write zone. */
  lint: readonly string[] = [],
  /** Surface violations from surface-check.ts: public exports or members the
   *  contract does not declare, or declared surface the implementation
   *  dropped. Run 8 shipped Money.signed plus nine undeclared re-exports this
   *  way — a contract that binds only at scaffold time is a compile step, not
   *  a contract. Always the builder's: the remedy is "make it private" or a
   *  CONTRACT-DISPUTE, both of which start with the builder. */
  surface: readonly string[] = [],
  /** Source files still importing from the red-phase errors module (see
   *  skeleton-imports.ts). r16: billing.ts stayed a throwing skeleton and green
   *  passed 179/179 twice, because no test imported its exports so nothing ran
   *  the throw. An unimplemented export is not GREEN whatever the suite says.
   *  Always the builder's: implementing the skeleton is its job. */
  skeletons: readonly SkeletonImporter[] = [],
  /** Who owns each file: the composed layout or `projectOwnerOf(cwd)`. */
  ownership: PathLayout | OwnerOf = UNREADABLE_LAYOUT,
): GateResult {
  const suite = suiteVerdict(run);
  const types = routeTypecheck(tsc.diagnostics, ownership);

  if (
    suite === null &&
    types.errorCount === 0 &&
    lint.length === 0 &&
    surface.length === 0 &&
    skeletons.length === 0
  ) {
    return {
      code: 0,
      verdict: "pass",
      summary: `GREEN (${run.passed}/${run.total} passed, typecheck clean)`,
      lines: [
        `green-gate: OK — ${run.passed} passed, ${run.total} total, typecheck clean`,
      ],
      detail: { passed: run.passed, total: run.total, skipped: run.skipped, typeErrors: 0 },
    };
  }

  // A type error is reported even when the suite is fine — that is exactly the
  // Run 3 false green — and the headline says so, so the log is unambiguous.
  // A surviving skeleton is the r16 case: the suite is green, but green over an
  // export nothing implemented is a false green in the same family.
  const skeletonHeadline = [
    `green-gate: FAIL — ${skeletons.length} source file${skeletons.length === 1 ? "" : "s"} still ` +
      `import${skeletons.length === 1 ? "s" : ""} from the red-phase errors module; the suite passes ` +
      `(${run.passed}/${run.total}) but an unimplemented skeleton reached green — no test executes its ` +
      `NotImplementedError throw`,
  ];
  const headline =
    suite?.lines ??
    (types.errorCount > 0
      ? [
          `green-gate: FAIL — ${types.errorCount} type error${types.errorCount === 1 ? "" : "s"}; the suite passes (${run.passed}/${run.total}) but the project is not type-clean`,
        ]
      : lint.length > 0
        ? [
            `green-gate: FAIL — ${lint.length} escape hatch${lint.length === 1 ? "" : "es"} in the builder's source; the suite passes (${run.passed}/${run.total}) but the type checker was switched off to get there`,
          ]
        : surface.length > 0
          ? [
              `green-gate: FAIL — ${surface.length} surface violation${surface.length === 1 ? "" : "s"}; the suite passes (${run.passed}/${run.total}) but the public surface does not match the contract`,
            ]
          : skeletonHeadline);
  const lintLines =
    lint.length > 0
      ? [...lint, "green-gate: a non-null assertion, cast, any or ts-comment is a gate failure, not a style note — fix the cause the type checker was pointing at"]
      : [];
  const surfaceLines = surface.length > 0 ? [...surface] : [];
  const skeletonLines =
    skeletons.length > 0
      ? [...skeletons.map((s) => `  skeleton: ${s.file} imports ${s.names.join(", ")}`)]
      : [];
  const route = mostUpstream([
    ...(suite ? [suite.owner] : []),
    ...types.owners,
    ...(lint.length > 0 || surface.length > 0 || skeletons.length > 0 ? ["builder" as const] : []),
  ]);
  const summary = [
    suite?.summary,
    types.errorCount > 0 ? `${types.errorCount} type error${types.errorCount === 1 ? "" : "s"}` : undefined,
    lint.length > 0 ? `${lint.length} escape hatch${lint.length === 1 ? "" : "es"}` : undefined,
    surface.length > 0 ? `${surface.length} surface violation${surface.length === 1 ? "" : "s"}` : undefined,
    skeletons.length > 0 ? `${skeletons.length} unimplemented skeleton${skeletons.length === 1 ? "" : "s"}` : undefined,
  ]
    .filter((s) => s !== undefined)
    .join(" + ");

  return {
    code: 1,
    verdict: "block",
    summary: `${summary} (route: ${route})`,
    lines: [...headline, ...typecheckLines(types), ...lintLines, ...surfaceLines, ...skeletonLines, `green-gate: route → ${route}`],
    detail: {
      ...(suite?.detail ?? {
        reason:
          types.errorCount > 0
            ? "type-errors"
            : lint.length > 0
              ? "escape-hatches"
              : surface.length > 0
                ? "surface"
                : "skeleton",
        passed: run.passed,
        total: run.total,
      }),
      typeErrors: types.errorCount,
      escapeHatches: lint.length,
      surfaceViolations: surface.length,
      skeletonImports: skeletons.map((s) => s.file),
      route,
      typeErrorOwners: types.owners,
    },
  };
}

// --- CLI ------------------------------------------------------------------------

/**
 * Run the green gate and return its verdict without printing or exiting.
 *
 * The architect holds no `bash`, so it reaches this gate through the
 * `green_gate` tool rather than a shell. Both routes MUST run the same gate —
 * "the orchestrator runs every gate itself and never trusts a worker's word"
 * is worth nothing if the tool is a second, drifting implementation. So the
 * CLI below is a thin wrapper over this function, and so is the tool.
 */
/** Failing-test-name sets from this project's prior green-gate blocks, oldest→newest. */
function priorGreenFailures(cwd: string): string[][] {
  try {
    return readGuardLog(cwd)
      .filter((e) => e.guard === GUARD && e.verdict === "block")
      .map((e) => {
        const names = (e.detail as { names?: unknown } | undefined)?.names;
        return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
      })
      .filter((names) => names.length > 0);
  } catch {
    return []; // an unreadable log must never break the gate
  }
}

/**
 * Green requires a valid red for the CURRENT contracts — enforced, not asked.
 *
 * Run 10 (kimi): the architect revised its contract mid-loop, re-froze, never
 * got a red pass for the new shape, ran green anyway, and green passed 148/148
 * — then its own sign-off admitted "the red gate cannot pass with this
 * contract shape". A green over a never-validated suite is exactly the failure
 * the pipeline exists to prevent: without a red, nothing proves the 148 tests
 * CAN fail. The skill said the ordering in prose; prose executed unreliably,
 * as it always does. So: the guard log must contain a red-gate pass AFTER the
 * most recent contract freeze (checksum-gate "wrote manifest"), or green
 * refuses before running anything.
 */
export function redPassStandsForCurrentContracts(
  events: readonly { guard: string; verdict: string; summary: string }[],
): boolean {
  return lastStandingRedPass(events) !== undefined;
}

/** A guard event as the binding reads it: verdict, summary, and the detail the
 *  gate recorded about what it ran against. */
interface BindingEvent {
  readonly guard: string;
  readonly verdict: string;
  readonly summary: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** The red-gate pass that came after the last contract freeze, if there is one. */
function lastStandingRedPass(events: readonly BindingEvent[]): BindingEvent | undefined {
  let lastFreeze = -1;
  let lastRedPass = -1;
  events.forEach((e, i) => {
    if (e.guard === "checksum-gate" && e.verdict === "pass" && e.summary.includes("wrote manifest")) lastFreeze = i;
    if (e.guard === "red-gate" && e.verdict === "pass") lastRedPass = i;
  });
  return lastRedPass > lastFreeze ? events[lastRedPass] : undefined;
}

/** Why the standing red does not cover this green, or `ok`. */
export type RedBinding =
  | { readonly ok: true }
  /** No red-gate pass since the contracts were last frozen (Run 10). */
  | { readonly ok: false; readonly reason: "no-red" }
  /** A red stands, but a test-side file has been edited since it was measured. */
  | { readonly ok: false; readonly reason: "tests-changed" }
  /** A red stands but recorded no tests hash, so nothing can be bound to it. */
  | { readonly ok: false; readonly reason: "unbound-red" };

/**
 * Does a red still cover the work green is about to bless?
 *
 * Two halves, both enforced rather than asked:
 *
 *  · CONTRACTS — a red pass after the most recent freeze (see
 *    `redPassStandsForCurrentContracts` and Run 10's 148/148 false green).
 *
 *  · TESTS — that red pass must have been measured over THESE tests. Red now
 *    runs against a shadow project so that the test-writer and the builder can
 *    work in parallel; the cost of that freedom is that the two workers move
 *    independently, and a test edited after the red went green is a test
 *    nothing has ever proven CAN fail. Comparing `testsTreeHash` closes it:
 *    the red records the hash of the tree it ran against, and green refuses
 *    unless the tree still hashes the same. The fix is one command — re-run
 *    red_gate, which does not disturb the builder's code — so the message says so.
 *
 * Pure: the caller supplies the events and the current hash.
 */
export function redBindingFor(events: readonly BindingEvent[], testsHash: string): RedBinding {
  const red = lastStandingRedPass(events);
  if (red === undefined) return { ok: false, reason: "no-red" };
  const recorded = (red.detail as { testFilesHash?: unknown } | undefined)?.testFilesHash;
  if (typeof recorded !== "string" || recorded === "") return { ok: false, reason: "unbound-red" };
  return recorded === testsHash ? { ok: true } : { ok: false, reason: "tests-changed" };
}

/** The verdict when no red covers this green. One shape per reason, each
 *  naming the role that can fix it and the command that fixes it. */
function refusal(reason: "no-red" | "tests-changed" | "unbound-red"): GateResult {
  if (reason === "no-red") {
    return {
      code: 1,
      verdict: "block",
      summary: "no valid red for the current contracts",
      lines: [
        "green-gate: FAIL — no red-gate pass since the contracts were last frozen",
        "  A green over a never-validated suite proves nothing: without a red, nothing",
        "  shows these tests CAN fail. Run red_gate first; if you revised a contract,",
        "  the red must be re-established for the new shape.",
        "green-gate: route → architect",
      ],
      detail: { reason: "no-red", route: "architect" },
    };
  }
  const headline =
    reason === "tests-changed"
      ? "green-gate: FAIL — a test-side file has changed since the red-gate pass that covers it"
      : "green-gate: FAIL — the standing red-gate pass recorded no test-files hash, so no red covers these tests";
  return {
    code: 1,
    verdict: "block",
    summary: reason === "tests-changed" ? "tests changed since the red" : "standing red records no test-files hash",
    lines: [
      headline,
      "  The red proved THOSE tests can fail; a test edited afterwards is unproven, and",
      "  a green over an unproven test is the same false green in new clothes.",
      "  Re-run red_gate — it builds its own shadow project, so it neither needs nor",
      "  touches the builder's code, and the builder can keep working while it runs.",
      "green-gate: route → test-writer",
    ],
    detail: { reason, route: "test-writer" },
  };
}

function blockAndLog(cwd: string, result: GateResult): GateResult {
  logGuardEvent(cwd, { guard: GUARD, verdict: result.verdict, summary: result.summary, detail: result.detail });
  return result;
}

export interface GreenGateOptions {
  /** The composed green policies; tests inject fakes. */
  readonly policy?: PhaseRun;
}

export async function runGreenGate(cwd: string, options: GreenGateOptions = {}): Promise<GateResult> {
  // The suite and typecheck load the project's config: it must be what the
  // composed packs generate (ADR LEG-2026-054).
  const configBlock = configDriftBlock(GUARD, cwd);
  if (configBlock !== undefined) return configBlock;
  let hash: string;
  try {
    hash = testFilesHash(cwd);
  } catch (error) {
    return blockAndLog(cwd, {
      code: 2, verdict: "error", summary: "the test-side files cannot be read",
      lines: [`green-gate: ERROR — the test-side files cannot be read (${error instanceof Error ? error.message : String(error)})`],
      detail: { reason: "unreadable-layout" },
    });
  }
  const binding = redBindingFor(readGuardLog(cwd), hash);
  if (!binding.ok) return blockAndLog(cwd, refusal(binding.reason));

  // The green-only obligations are static: checked before anything starts,
  // so a smoke test that would reach for a database it did not start never
  // runs at all (issue #52).
  const obligations = greenObligations(cwd);
  if (obligations !== undefined) return blockAndLog(cwd, obligations);

  // Store tests need a container runtime at green (ADR LEG-2026-064): refuse
  // rather than run a suite whose store tests cannot start.
  const policy = options.policy ?? phaseRun(cwd, "green");
  if (policy.refusals.length > 0) {
    const route = policy.refusalRoute ?? "orchestrator";
    return blockAndLog(cwd, {
      code: 1,
      verdict: "block",
      summary: "a test level cannot run on this machine",
      lines: [
        ...policy.refusals.map((reason) => `green-gate: FAIL — ${reason}`),
        `green-gate: route → ${route}`,
      ],
      detail: { reason: "test-policy", refusals: policy.refusals, route },
    });
  }

  let roots: readonly string[];
  try {
    roots = sourceRoots(cwd);
  } catch {
    roots = [];
  }
  // A policy may start what the run needs (ts-drizzle-postgres: a
  // Testcontainers preflight); it is released after.
  const prepared = await withPreparedServices(policy, (env) => Promise.all([
    runTests(cwd, { ...gateOptionsFromEnv(), env, timeoutMs: GATE_SUITE_TIMEOUT_MS }),
    typecheck(cwd, gateTypecheckOptionsFromEnv()),
    lintSrc(cwd),
  ]));
  if (!prepared.ok) {
    const route = prepared.route ?? "orchestrator";
    return blockAndLog(cwd, {
      code: 1,
      verdict: "block",
      summary: "a service the test run needs could not start",
      lines: [`green-gate: FAIL — ${prepared.reason}`, `green-gate: route → ${route}`],
      detail: { reason: "test-policy", refusals: [prepared.reason], route },
    });
  }
  const [run, tsc, lint] = prepared.value;
  // Failures a policy recognises as the machine's (a container start that
  // could not pull, authenticate or reach the runtime). Only when EVERY
  // failure is the machine's does the run go to the user, whose machine it
  // is (ADR LEG-2026-072): one such
  // failure must never hide a real one, so on a mix the verdict stays the
  // code's and the machine's causes ride along as a note.
  const infrastructure = policy.infrastructure([
    ...run.results.filter((r) => r.status === "failed").map((r) => ({ name: r.name, ...(r.message !== undefined ? { message: r.message } : {}), ...(r.file !== undefined ? { file: r.file } : {}) })),
    ...(run.unhandled !== undefined ? [{ name: "unhandled error", message: run.unhandled }] : []),
    ...(run.blocked !== undefined ? [{ name: "suite did not run", message: run.blocked }] : []),
  ]);
  if (infrastructure.all) {
    const n = infrastructure.causes.length;
    return blockAndLog(cwd, {
      code: 1,
      verdict: "block",
      summary: "tests failed because of the machine, not the code",
      lines: [
        ...prepared.lines.map((line) => `green-gate: ${line}`),
        `green-gate: FAIL — every failure is the machine's, not the code's; no role can fix ${n === 1 ? "it" : "them"}`,
        ...infrastructure.causes.map((cause) => `  ${cause}`),
        "green-gate: route → user",
      ],
      detail: { reason: "infrastructure", causes: infrastructure.causes, route: "user" },
    });
  }
  // Surface check is synchronous ts-morph work; a code-2 (no contracts, or a
  // missing implementation file) is not a finding here — the suite and
  // typecheck verdicts already own those failure modes.
  const surfaces = checkProjectSurfaces(cwd, roots);
  // A surviving red-phase skeleton (r16): green only because no test executes
  // an unimplemented throw is not green.
  const skeletons = findSkeletonImports(cwd, roots);
  // A lint ERROR (no files matched) is not a finding: an empty source root is
  // the builder's problem to have, and the suite verdict already says so.
  const base = classifyGreen(
    run,
    tsc,
    lint.code === 1 ? lint.lines.slice(0, -1) : [],
    // A missing implementation or no contract found (code 2) is a finding
    // too: a surface nobody checked is not a matching one.
    surfaces.code === 1 ? surfaces.lines.slice(0, -1) : surfaces.code === 2 ? [...surfaces.lines] : [],
    skeletons,
    projectOwnerOf(cwd),
  );
  // Reroute a repeat. classifyGreen stays pure — the history lives in the guard
  // log, which is where every other convergence check already reads from.
  const names = (base.detail as { names?: unknown }).names;
  const failing = Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
  const result =
    base.verdict === "block" && failing.length > 0 && (base.detail as { reason?: unknown }).reason === "failures"
      ? rerouteIfRepeated(base, failing, priorGreenFailures(cwd))
      : base;

  const noted = infrastructure.causes.length === 0 ? result : withInfrastructureNote(result, infrastructure.causes);
  const reported = prepared.lines.length === 0 ? noted : { ...noted, lines: [...prepared.lines.map((line) => `green-gate: ${line}`), ...noted.lines] };
  logGuardEvent(cwd, { guard: GUARD, verdict: reported.verdict, summary: reported.summary, detail: reported.detail });
  return reported;
}

/** The code's verdict, with the failures that also look like the machine's
 *  named just before the route line: the role still owns the run. */
function withInfrastructureNote(base: GateResult, causes: readonly string[]): GateResult {
  const note = [
    `${GUARD}: note — ${causes.length === 1 ? "one failure looks" : `${causes.length} failures look`} like the machine's, not the code's; ` +
      "the others are the code's, so the route stands. If the machine's persists, it is the user's to fix, in product terms:",
    ...causes.map((cause) => `  suspected infrastructure: ${cause}`),
  ];
  const at = base.lines.findIndex((line) => line.startsWith(`${GUARD}: route →`));
  const lines = at < 0 ? [...base.lines, ...note] : [...base.lines.slice(0, at), ...note, ...base.lines.slice(at)];
  return { ...base, lines, detail: { ...(base.detail as Record<string, unknown>), suspectedInfrastructure: causes } };
}

/** The green-only test obligations (an app's smoke test, ADR LEG-2026-063; its
 *  own database, ADR LEG-2026-072): a block before anything runs, or undefined. */
export function greenObligations(cwd: string, guard = GUARD): GateResult | undefined {
  let gaps;
  try {
    gaps = checkObligations(readObligationInput(cwd, projectFactsOf(cwd, "deliver"), "green"));
  } catch (error) {
    gaps = [{ level: "obligations", message: `the obligations could not be read: ${error instanceof Error ? error.message : String(error)}` }];
  }
  if (gaps.length === 0) return undefined;
  return {
    code: 1,
    verdict: "block",
    summary: `${gaps.length} green test obligation${gaps.length === 1 ? "" : "s"} unmet (route: test-writer)`,
    lines: [
      `${guard}: FAIL — ${gaps.length} green test obligation${gaps.length === 1 ? " is" : "s are"} unmet; nothing was run`,
      ...obligationLines(gaps),
      `${guard}: route → test-writer`,
    ],
    detail: { reason: "obligations", gaps: gaps.map((g) => ({ level: g.level, path: g.path, message: g.message })), route: "test-writer" },
  };
}

/** Rewrite the route line when the same tests have failed twice running. */
function rerouteIfRepeated(
  base: GateResult,
  failing: readonly string[],
  prior: readonly (readonly string[])[],
): GateResult {
  const owner = routeAfterRepeat(failing, prior);
  if (owner !== "test-writer") return base;
  return {
    ...base,
    summary: `${base.summary.replace(/\(route: [^)]*\)/, "")}(route: test-writer, repeated)`.replace(/\s+/g, " ").trim(),
    lines: [
      ...base.lines.filter((l) => !l.startsWith(`${GUARD}: route →`)),
      `${GUARD}: the same ${failing.length === 1 ? "test has" : "tests have"} now failed twice running — the builder is not converging, so the TEST is the likelier defect`,
      `${GUARD}: route → test-writer`,
    ],
    detail: { ...(base.detail as Record<string, unknown>), route: "test-writer", repeated: true },
  };
}

async function main(argv: string[]): Promise<number> {
  const result = await runGreenGate(argv[0] ?? process.cwd());
  for (const line of result.lines) console.log(line);
  return result.code;
}

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
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`green-gate: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
