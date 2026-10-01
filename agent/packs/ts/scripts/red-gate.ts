// red gate (TN-26-001, TEST → BUILD boundary, §"Test-runner gates").
//
//   bounded gates red-gate [targetDir]
//
// Runs the project's suite with `bun test` (through the shared run_tests
// runner, JUnit report, ADR 2026-062) AND `bunx tsc`, and asserts a VALID red:
// the project TYPECHECKS, the suite RUNS, every test fails, and EVERY failure
// is a NotImplementedError. Red only proves something if someone checks WHY it
// went red (TN-26-001 Appendix, Böckeler). Wrong-reason red — import errors,
// config errors, type/runtime errors, ordinary assertion failures — is
// REJECTED, naming the offending test. A fully-passing suite at the red phase
// is ALSO a fail: nothing is waiting to be built.
//
// RED ALSO REQUIRES A TYPE-CLEAN PROJECT (issue #7): a test-side type error is
// the test-writer's to fix, and this is the last gate where that is cheap.
//
// THE GATE RUNS AGAINST A SHADOW PROJECT, NOT THE LIVE TREE. "Every failure
// is a NotImplementedError" is only measurable against unimplemented
// skeletons, so the gate rebuilds the project at `<project>/.bounded/shadow-red/`
// from what the builder cannot touch, and runs every check there:
//
//   copied      the contracts, the test-writer's test-side files in every
//               context workspace, the generated files on disk (migrations,
//               the rulebook), the root config and every workspace manifest
//   emitted     every composed emitter's output at phase `red` (ADR 2026-060):
//               fresh skeletons that throw, and the generated files over the
//               copies — so the shadow is the project the design scaffolds,
//               whatever the builder has written since
//   linked      `node_modules`, the root's and each workspace's, rebuilt as
//               real directories: a link into the dependency store points at
//               the live store, and a link into a WORKSPACE (Bun's isolated
//               installs link `@scope/<context>` per workspace, relative to
//               the live tree) points at the shadow's copy. Otherwise a test
//               resolving `@scope/<context>/domain` would load the builder's
//               half-written code, and the red would be about the live tree.
//               The gate verifies no link reaches a live workspace.
//
// Tests of workspaces with no contract (an app's smoke test) and root-level
// test files (the generated architecture test) run at green only: nothing a
// skeleton does can make them fail for the right reason.
//
// Store tests (ADR 2026-064): the composed phase test policies decide, and
// without a container runtime the store tests are skipped with the reason
// logged — the skip is set in the TEST PROCESS's environment, never the gate's.
//
// Exit 0 valid red · 1 invalid red (one greppable line each) · 2 misuse
// (target unrunnable / bad invocation). Logs one guard event to the target's
// .bounded/guard-log.jsonl, carrying the contract manifest and the test-files
// hash the verdict was made against. Green binds itself to the hash; the
// manifest is the audit record (the freeze itself stales a red, green-gate.ts).
//
// The suite and tsc commands are injectable for testing via BOUNDED_GATE_TEST_CMD /
// BOUNDED_GATE_TEST_ARGS and BOUNDED_GATE_TSC_CMD / BOUNDED_GATE_TSC_ARGS (JSON arrays).

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { GateResult } from "../../../src/gate-result.ts";
import { logGuardEvent } from "../../../src/guard-log.ts";
import {
  fileNameGlobs,
  fileNameMatcher,
  generatedFileGlobs,
  hasTestFileSuffix,
  pathGlobMatcher,
  sourceRoots,
  testFileSuffixes,
} from "../../../src/pack-contrib.ts";
import { expandSourceRoots } from "../../../src/path-gate.ts";
import { UNREADABLE_LAYOUT, type PathLayout } from "../../../src/path-policy.ts";
import { readProjectPacks } from "../../../src/project-composition.ts";
import type { ProjectFacts } from "../pack.ts";
import { computeManifest } from "./checksum-gate.ts";
import { lintTests } from "./lint-src.ts";
import { phaseRun, type PhaseRun } from "./phase-policy.ts";
import { configDriftBlock, harnessRootOf } from "./project-config.ts";
import { emitProject, projectFactsOf, type ProjectFile } from "./project-emitters.ts";
import { MANIFEST } from "./project-package.ts";
import { runTests, summarizeResults, type RunTestsOptions, type RunTestsResult } from "./run-tests.ts";
import { UNHANDLED_NAME } from "./sanitize-test-output.ts";
import { checkObligations, obligationLines, readObligationInput, reachedNames } from "./test-obligations.ts";
import { typecheck, type TypecheckOptions, type TypecheckResult } from "./typecheck.ts";
import { mostUpstream, projectOwnerOf, routeTypecheck, typecheckLines, type OwnerOf } from "./typecheck-routing.ts";

const GUARD = "red-gate";

// Name-based detection: the scaffolder's skeletons throw NotImplementedError
// (shared errors module), so a valid-red failure message starts with that
// class name. The sanitizer keeps the error-name line while dropping stacks,
// code frames, and paths, so the name survives to here.
const NOT_IMPLEMENTED = /(^|\n)\s*NotImplementedError\b/;

export function isNotImplementedFailure(message: string | undefined): boolean {
  return message !== undefined && NOT_IMPLEMENTED.test(message);
}

function firstLine(message: string | undefined): string {
  return message && message.trim() !== "" ? message.split("\n")[0] : "(no failure message)";
}

/** The suite half of the red verdict. Pure: no I/O, no logging. */
function classifySuite(run: RunTestsResult): GateResult {
  // The suite could not even produce a report (import/config error, crash):
  // that is a wrong-reason red — the suite is broken, not pending.
  if (run.blocked !== undefined) {
    return {
      code: 1,
      verdict: "block",
      summary: "wrong-reason red: suite did not run",
      lines: [
        "red-gate: FAIL — suite did not run; red must fail BECAUSE NotImplemented, not because the suite is broken",
        ...run.blocked.split("\n").map((l) => `  ${l}`),
      ],
      detail: { reason: "blocked", blocked: run.blocked },
    };
  }
  // No tests executed: a red phase needs failing tests.
  if (run.total === 0) {
    return {
      code: 1,
      verdict: "block",
      summary: "no tests ran",
      lines: ["red-gate: FAIL — no tests ran; a red phase needs failing tests (silence is not success)"],
      detail: { reason: "no-tests" },
    };
  }
  // Fully passing at red is a fail: nothing is waiting to be built.
  if (run.failed === 0 && run.passed === run.total) {
    return {
      code: 1,
      verdict: "block",
      summary: "suite fully passes at red phase",
      lines: [
        `red-gate: FAIL — suite fully passes (${run.passed}/${run.total}); red phase expects NotImplemented failures`,
      ],
      detail: { reason: "fully-green", passed: run.passed, total: run.total },
    };
  }
  // Every failure must be a NotImplementedError.
  // A failure outside any test (a throw while bun collects a file) hides every
  // test in that file, whatever it threw: never a right-reason failure.
  const outsideTests = (r: RunTestsResult["results"][number]): boolean => r.name === UNHANDLED_NAME || r.name === "(test file)";
  const offenders = run.results.filter((r) => r.status === "failed" && (outsideTests(r) || !isNotImplementedFailure(r.message)));
  if (offenders.length > 0) {
    // A FILE-level failure whose message mentions NotImplemented reads as a
    // contradiction — "the right error is the wrong reason?" — and it cost
    // Run 8's architect 25 minutes and five bounces against the wrong
    // hypothesis. It is not a contradiction: the throw happened during
    // import/collection, before any test ran. A skeleton call at the top
    // level of a test file (building fixtures outside `test()`) throws while
    // bun is still collecting, so no test ever gets to fail for the right
    // reason. The gate is correct to block; the message must say WHY.
    const collectionFailures = offenders.filter(
      (o) => outsideTests(o) && o.message !== undefined && /NotImplemented|Not implemented/.test(o.message),
    );
    return {
      code: 1,
      verdict: "block",
      summary: `${offenders.length} wrong-reason failure${offenders.length === 1 ? "" : "s"}`,
      lines: [
        `red-gate: FAIL — ${offenders.length} failure${offenders.length === 1 ? "" : "s"} not caused by NotImplementedError (wrong-reason red)`,
        ...offenders.map((o) => `  wrong-reason: ${o.name} — ${firstLine(o.message)}`),
        ...(collectionFailures.length > 0
          ? [
              `red-gate: a NotImplemented thrown ${UNHANDLED_NAME} happened during IMPORT/COLLECTION, not in a test:`,
              "  something calls a skeleton export at the top level of a test file (e.g. building a",
              "  fixture with Currency.parse(...) outside test()). Move every such call inside a",
              "  test() or a beforeEach — the file must be importable while nothing is implemented.",
            ]
          : []),
      ],
      detail: {
        reason: "wrong-reason",
        offenders: offenders.map((o) => ({ name: o.name, message: firstLine(o.message) })),
        ...(collectionFailures.length > 0 ? { collectionFailures: collectionFailures.length } : {}),
      },
    };
  }
  // A test that passes against an entirely unimplemented project cannot
  // distinguish the intended implementation from its absence. Run 20 carried
  // 11 such tests through a valid-red verdict: one right-reason failure was
  // enough to mask assertions that proved nothing about the delivered code.
  if (run.passed > 0) {
    const passing = run.results.filter((r) => r.status === "passed").map((r) => r.name);
    const inconclusive = run.results.filter((r) => r.status !== "failed" && r.status !== "passed");
    return {
      code: 1,
      verdict: "block",
      summary: `${run.passed} test${run.passed === 1 ? "" : "s"} passed against unimplemented skeleton`,
      lines: [
        `red-gate: FAIL — ${run.passed} test${run.passed === 1 ? "" : "s"} passed against the unimplemented skeleton; every test must fail for NotImplementedError`,
        ...passing.map((name) => `  passed against skeleton: ${name}`),
        ...inconclusive.map((result) => `  did not fail: ${result.name} (${result.status})`),
      ],
      detail: { reason: "spurious-pass", passing, ...(inconclusive.length > 0 ? { inconclusive: inconclusive.map((r) => ({ name: r.name, status: r.status })) } : {}) },
    };
  }
  const inconclusive = run.results.filter((r) => r.status !== "failed");
  if (inconclusive.length > 0) {
    return {
      code: 1,
      verdict: "block",
      summary: `${inconclusive.length} test${inconclusive.length === 1 ? "" : "s"} did not fail against unimplemented skeleton`,
      lines: [
        "red-gate: FAIL — every collected test must run and fail for NotImplementedError; some were skipped, pending or unrecognized",
        ...inconclusive.map((result) => `  did not fail: ${result.name} (${result.status})`),
      ],
      detail: { reason: "non-red-tests", inconclusive: inconclusive.map((r) => ({ name: r.name, status: r.status })) },
    };
  }
  if (run.failed !== run.total) {
    return {
      code: 1,
      verdict: "block",
      summary: "inconsistent test report",
      lines: ["red-gate: FAIL — the test report does not account for every collected test"],
      detail: { reason: "inconsistent-report", total: run.total, failed: run.failed },
    };
  }
  return {
    code: 0,
    verdict: "pass",
    summary: `RED OK (${run.failed} NotImplemented failure${run.failed === 1 ? "" : "s"}, ${run.passed} passed)`,
    lines: [
      `red-gate: OK — ${run.failed} NotImplemented failure${run.failed === 1 ? "" : "s"}, ${run.passed} passed, ${run.total} total`,
    ],
    detail: { failed: run.failed, passed: run.passed, total: run.total },
  };
}

/**
 * Classify a run against the red-gate contract. Pure: no I/O, no logging.
 * A valid red requires BOTH a right-reason red suite and a type-clean
 * project (#7). Every red-phase failure is the test-writer's to fix unless a
 * type error points further upstream (a broken contract is the architect's).
 */
/**
 * The generated laws' half of the red (ADR 2026-058/060). A law exercises
 * generated code as well as skeletons (a command's wire checks run before any
 * value object does), so a law may PASS against the skeletons. It may not
 * fail for any other reason than NotImplementedError, and it may not skip:
 * a law skips when a contract gives it no `@accepts` examples, which is the
 * architect's to fix. Undefined when the laws are in order.
 */
export function classifyGeneratedLaws(results: RunTestsResult["results"]): GateResult | undefined {
  const wrong = results.filter((r) => r.status === "failed" && !isNotImplementedFailure(r.message));
  const skipped = results.filter((r) => r.status !== "failed" && r.status !== "passed");
  if (wrong.length === 0 && skipped.length === 0) return undefined;
  return {
    code: 1,
    verdict: "block",
    summary: `${wrong.length + skipped.length} generated law${wrong.length + skipped.length === 1 ? "" : "s"} not in order (route: architect)`,
    lines: [
      "red-gate: FAIL — the generated laws must pass or fail for NotImplementedError, and none may skip",
      ...wrong.map((r) => `  wrong-reason law: ${r.name} — ${firstLine(r.message)}`),
      ...skipped.map((r) => `  law not run: ${r.name} (${r.status}) — give the contract's value objects @accepts examples`),
      "red-gate: route → architect",
    ],
    detail: { reason: "generated-laws", wrong: wrong.map((r) => r.name), skipped: skipped.map((r) => r.name), route: "architect" },
  };
}

/** A run restricted to some of its results, tallies recomputed. */
function restricted(run: RunTestsResult, keep: (r: RunTestsResult["results"][number]) => boolean): RunTestsResult {
  const results = run.results.filter(keep);
  return { ...run, results, ...summarizeResults(results) };
}

export function classifyRed(
  run: RunTestsResult,
  tsc: TypecheckResult,
  /** Who owns each file: the composed layout or `projectOwnerOf(cwd)`. */
  ownership: PathLayout | OwnerOf = UNREADABLE_LAYOUT,
  /** Is a result's test file generated? Their results are judged by
   *  `classifyGeneratedLaws`; every other result must fail. */
  isGeneratedFile: (file: string) => boolean = () => false,
): GateResult {
  const fromLaws = (r: RunTestsResult["results"][number]): boolean => r.file !== undefined && isGeneratedFile(r.file);
  const laws = run.blocked === undefined ? classifyGeneratedLaws(run.results.filter(fromLaws)) : undefined;
  const suite = laws ?? classifySuite(restricted(run, (r) => !fromLaws(r)));
  const types = routeTypecheck(tsc.diagnostics, ownership);

  if (!tsc.ok && types.errorCount === 0) {
    return {
      code: 1,
      verdict: "block",
      summary: "typecheck did not complete",
      lines: [
        "red-gate: FAIL — typecheck did not complete; a red requires a type-clean project",
        ...tsc.diagnostics.map((line) => `  typecheck: ${line}`),
      ],
      detail: { reason: "typecheck-failed", diagnostics: tsc.diagnostics },
    };
  }

  if (types.errorCount === 0) {
    if (suite.code === 0) return { ...suite, lines: [`${suite.lines[0]}, typecheck clean`, ...suite.lines.slice(1)] };
    return laws !== undefined ? suite : { ...suite, lines: [...suite.lines, "red-gate: route → test-writer"], detail: { ...suite.detail, route: "test-writer" } };
  }

  const plural = types.errorCount === 1 ? "" : "s";
  const headline =
    suite.code === 0
      ? [`red-gate: FAIL — ${types.errorCount} type error${plural}; red is valid but the project is not type-clean`]
      : suite.lines;
  // The test-writer owns anything wrong at TEST; a type error may point further up.
  const route = mostUpstream([laws !== undefined ? "architect" : "test-writer", ...types.owners]);
  const summary = suite.code === 0 ? `${types.errorCount} type error${plural}` : `${suite.summary} + ${types.errorCount} type error${plural}`;

  return {
    code: 1,
    verdict: "block",
    summary: `${summary} (route: ${route})`,
    lines: [...headline, ...typecheckLines(types), `red-gate: route → ${route}`],
    detail: {
      ...(suite.code === 0 ? { reason: "type-errors" } : suite.detail),
      typeErrors: types.errorCount,
      route,
      typeErrorOwners: types.owners,
    },
  };
}

// --- CLI ------------------------------------------------------------------------

/** Test seam: override the suite command without spawning real bun. */
export function gateOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RunTestsOptions {
  const command = env["BOUNDED_GATE_TEST_CMD"];
  if (!command) return {};
  const args = JSON.parse(env["BOUNDED_GATE_TEST_ARGS"] ?? "[]") as string[];
  return { command, args };
}

/** The same seam for the gates' typecheck run (both red and green typecheck). */
export function gateTypecheckOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): TypecheckOptions {
  const command = env["BOUNDED_GATE_TSC_CMD"];
  if (!command) return {};
  const args = JSON.parse(env["BOUNDED_GATE_TSC_ARGS"] ?? "[]") as string[];
  return { command, args };
}

// --- the test files a green is bound to -------------------------------------------

/** Project-relative files under `dir` (dependency and dot directories skipped). */
function walkFiles(root: string, dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/** Every test-side file a role wrote under the composed source roots (ADR
 *  2026-057): a composed test suffix, and no generated glob. Sorted. Throws
 *  when the composition is unreadable. */
export function testSideFiles(cwd: string): string[] {
  const suffixes = testFileSuffixes(cwd);
  const isGenerated = pathGlobMatcher(generatedFileGlobs(cwd));
  return expandSourceRoots(cwd, sourceRoots(cwd))
    .flatMap((root) => walkFiles(cwd, join(cwd, root)))
    .filter((path) => hasTestFileSuffix(path, suffixes) && !isGenerated(path))
    .sort();
}

/**
 * A deterministic fingerprint of the test-side files: sha256 over every file
 * `testSideFiles` lists, in path order, each contributing its path and its
 * newline-normalized content, NUL-separated so no rename can be disguised as
 * a content change. Generated laws are excluded: they are the design's, and
 * the contract manifest already binds the design.
 *
 * This is what binds a green to a red (green-gate.ts): the red proves THESE
 * tests can fail, and a test edited afterwards is unproven.
 */
export function testFilesHash(cwd: string): string {
  const hash = createHash("sha256");
  for (const rel of testSideFiles(cwd)) {
    hash.update(rel, "utf8");
    hash.update("\0");
    hash.update(readFileSync(join(cwd, rel), "utf8").replace(/\r\n/g, "\n"), "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

// --- the shadow project ----------------------------------------------------------

/** Where the shadow project lives, relative to the target project. Inside
 *  `.bounded/`, which delivery already gitignores, so a shadow can never reach a
 *  commit. */
export const SHADOW_RELATIVE = ".bounded/shadow-red";

/** Absolute path of the shadow project for `cwd`: the suite and the type
 *  checker are spawned with it as their working directory. */
export function shadowProjectDir(cwd: string): string {
  return resolve(cwd, SHADOW_RELATIVE);
}

/** What the shadow is built from. Every path is project-relative. */
export interface ShadowPlan {
  /** Copied verbatim from the live tree. */
  readonly copy: readonly string[];
  /** Written from the emitters, over any copy. */
  readonly emitted: readonly ProjectFile[];
  /** Workspace directories whose `node_modules` is mirrored. */
  readonly workspaces: readonly string[];
}

/**
 * Plan the shadow for the project at `cwd`. Pure over its inputs apart from
 * listing the live tree. Implementation files are never copied: the builder's
 * code must not reach the shadow, or a partial implementation would turn
 * NotImplemented failures into ordinary assertion failures.
 */
export function redShadowPlan(cwd: string, facts: ProjectFacts, emitted: readonly ProjectFile[]): ShadowPlan {
  const contracts = facts.workspaces.flatMap((w) => w.contracts.map((c) => c.path));
  if (contracts.length === 0) throw new Error("red-gate: no contracts — nothing to run the tests against");
  const suffixes = testFileSuffixes(cwd);
  const isGenerated = pathGlobMatcher(generatedFileGlobs(cwd));
  const designed = facts.workspaces.filter((w) => w.contracts.length > 0).map((w) => `${w.sourceRoot}/`);
  const inDesigned = (path: string): boolean => designed.some((root) => path.startsWith(root));

  const tests = testSideFiles(cwd).filter(inDesigned);
  if (tests.length === 0) {
    throw new Error("red-gate: no tests found in any context workspace — a red is a positive claim, and silence is not one");
  }
  // Generated files on disk that no emitter writes (migrations, the shipped
  // rulebook): the shadow is only the scaffolded project if it has them too.
  // Test-side ones outside the designed workspaces are green-only.
  const generated = walkFiles(cwd, cwd).filter((path) =>
    isGenerated(path) && (inDesigned(path) || !hasTestFileSuffix(path, suffixes)));
  const isConfig = fileNameMatcher(fileNameGlobs("projectConfigNames", readProjectPacks(cwd), join(harnessRootOf(), "packs")));
  const rootConfig = readdirSync(cwd, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isConfig(entry.name))
    .map((entry) => entry.name);
  const manifests = facts.workspaces.map((w) => `${w.dir}/${MANIFEST}`).filter((path) => existsSync(join(cwd, path)));
  const copy = [...new Set([...contracts, ...tests, ...generated, ...rootConfig, ...manifests])].sort();
  return { copy, emitted, workspaces: facts.workspaces.map((w) => w.dir) };
}

/** Is `abs` inside `root` (or `root` itself)? */
function within(root: string, abs: string): boolean {
  const back = relative(root, abs);
  return back === "" || (!back.startsWith(`..${sep}`) && back !== ".." && !isAbsolute(back));
}

/** Is a live path a workspace's own code: inside the project, and not inside
 *  any dependency directory or harness state? */
function isLiveWorkspacePath(project: string, abs: string): boolean {
  if (!within(project, abs)) return false;
  const segments = relative(project, abs).split(sep);
  return !segments.includes("node_modules") && segments[0] !== ".bounded";
}

/**
 * Mirror one live `node_modules` into the shadow as a real directory. A link
 * whose target is a live workspace is re-pointed at the shadow's copy of that
 * workspace (relative, as Bun wrote it); every other entry links to the live
 * target, absolute. Scope directories (`@scope`) are mirrored one level down,
 * because that is where workspace links live.
 */
function mirrorModules(project: string, shadow: string, live: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(live, { withFileTypes: true })) {
    const from = join(live, entry.name);
    const to = join(target, entry.name);
    if (entry.isSymbolicLink()) {
      const raw = readlinkSync(from);
      const resolved = isAbsolute(raw) ? raw : resolve(dirname(from), raw);
      if (isLiveWorkspacePath(project, resolved)) {
        symlinkSync(relative(dirname(to), join(shadow, relative(project, resolved))), to);
      } else {
        symlinkSync(resolved, to);
      }
    } else if (entry.isDirectory() && entry.name.startsWith("@")) {
      mirrorModules(project, shadow, from, to);
    } else {
      symlinkSync(from, to);
    }
  }
}

/**
 * Every link in the shadow's `node_modules` trees (the root's and each
 * workspace's, scope directories included) that still resolves into a live
 * workspace, and every link in the live dependency store that does. Either
 * would let the shadow load the builder's code. Project-relative.
 */
export function shadowContamination(project: string, shadow: string, workspaces: readonly string[]): string[] {
  const out: string[] = [];
  const liveProject = realpathSync(project);
  const check = (dir: string, label: (name: string) => string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name.startsWith("@")) {
        check(path, (name) => label(`${entry.name}/${name}`));
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      let real: string;
      try {
        real = realpathSync(path);
      } catch {
        continue; // a dangling link loads nothing
      }
      if (isLiveWorkspacePath(liveProject, real) && !within(realpathSync(shadow), real)) out.push(label(entry.name));
    }
  };
  for (const dir of ["", ...workspaces]) {
    check(join(shadow, dir, "node_modules"), (name) => `${SHADOW_RELATIVE}/${dir === "" ? "" : `${dir}/`}node_modules/${name}`);
  }
  // Bun's isolated store hoists links under node_modules/.bun/node_modules.
  check(join(project, "node_modules", ".bun", "node_modules"), (name) => `node_modules/.bun/node_modules/${name}`);
  return out.sort();
}

/**
 * Build the shadow project and return its path. WIPED AND REBUILT on every
 * invocation: a shadow that accumulates can go stale, and a stale shadow is a
 * verdict about a project that no longer exists. It is LEFT BEHIND when the
 * gate finishes, so a red that failed for an unexplained reason can be
 * diagnosed by looking at the project it ran against; nothing reads it back.
 */
export function materializeShadow(cwd: string, plan: ShadowPlan): string {
  const dir = shadowProjectDir(cwd);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const rel of plan.copy) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(cwd, rel), join(dir, rel));
  }
  for (const file of plan.emitted) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    writeFileSync(join(dir, file.path), file.content);
  }
  for (const workspace of ["", ...plan.workspaces]) {
    const live = join(cwd, workspace, "node_modules");
    if (existsSync(live) && lstatSync(live).isDirectory()) mirrorModules(cwd, dir, live, join(dir, workspace, "node_modules"));
  }
  const contaminated = shadowContamination(cwd, dir, plan.workspaces);
  if (contaminated.length > 0) {
    throw new Error(`red-gate: the shadow would load live workspace code through ${contaminated.join(", ")}; ` +
      "the red cannot be isolated from the builder's work");
  }
  return dir;
}

// --- obligations ------------------------------------------------------------------

/**
 * What a red must ALSO discharge once it is otherwise valid (ADR 2026-063):
 * the per-level test files and reach (test-obligations.ts). Dogfood Run 7 is
 * why: a right-reason red that never called 9 of 15 exports. The test-writer's
 * to fix, at the last gate where fixing is cheap.
 */
function withObligations(cwd: string, facts: ProjectFacts, base: GateResult, run: RunTestsResult): GateResult {
  const reached = reachedNames(run.results.filter((r) => r.status === "failed").map((r) => r.message));
  let gaps;
  try {
    gaps = checkObligations(readObligationInput(cwd, facts, "red", reached));
  } catch (error) {
    gaps = [{ level: "obligations", message: `the obligations could not be read: ${error instanceof Error ? error.message : String(error)}` }];
  }
  if (gaps.length === 0) return base;
  return {
    code: 1,
    verdict: "block",
    summary: `${gaps.length} test obligation${gaps.length === 1 ? "" : "s"} unmet (route: test-writer)`,
    lines: [
      `red-gate: FAIL — the red is valid but incomplete: ${gaps.length} test obligation${gaps.length === 1 ? "" : "s"} unmet`,
      ...obligationLines(gaps),
      "red-gate: route → test-writer",
    ],
    detail: { reason: "obligations", gaps: gaps.map((g) => ({ level: g.level, path: g.path, message: g.message })), route: "test-writer" },
  };
}

/**
 * The inputs this verdict is a claim ABOUT, recorded so green can bind itself
 * to them: the contract manifest (checksum-gate's own) and the test-files
 * hash. Best effort: an unreadable tree records nothing, and green then
 * refuses to bind to this red.
 */
function redInputs(cwd: string, testsHash: string | undefined): Record<string, unknown> {
  try {
    return { contractManifest: computeManifest(cwd).files, ...(testsHash !== undefined ? { testFilesHash: testsHash } : {}) };
  } catch {
    return {};
  }
}

function hashOrUndefined(cwd: string): string | undefined {
  try {
    return testFilesHash(cwd);
  } catch {
    return undefined;
  }
}

/** A run with the results a policy skipped on purpose taken out, and the
 *  names of those results. */
export function withoutPolicySkips(run: RunTestsResult, policy: Pick<PhaseRun, "skippedOnPurpose">): { run: RunTestsResult; skipped: string[] } {
  const isPolicySkip = (r: RunTestsResult["results"][number]): boolean =>
    (r.status === "skipped" || r.status === "pending") && policy.skippedOnPurpose(r.name);
  const skipped = run.results.filter(isPolicySkip).map((r) => r.name);
  if (skipped.length === 0) return { run, skipped };
  const results = run.results.filter((r) => !isPolicySkip(r));
  return { run: { ...run, results, ...summarizeResults(results) }, skipped };
}

function gateError(cwd: string, summary: string, reason: string): GateResult {
  const result: GateResult = { code: 2, verdict: "error", summary, lines: [`red-gate: ERROR — ${summary}`], detail: { reason } };
  logGuardEvent(cwd, { guard: GUARD, verdict: result.verdict, summary, detail: result.detail });
  return result;
}

/** Run the red gate and return its verdict without printing or exiting. The
 *  `red_gate` tool and the CLI are thin wrappers over this. */
export async function runRedGate(cwd: string): Promise<GateResult> {
  // The shadow copies and runs the project's config: it must be what the
  // composed packs generate (ADR 2026-054).
  const configBlock = configDriftBlock(GUARD, cwd);
  if (configBlock !== undefined) return configBlock;

  let facts: ProjectFacts;
  let plan: ShadowPlan;
  let dir: string;
  // The test files the shadow copied: hashed before the copy and again after
  // the run, so a red never records tests it did not run.
  let before: string | undefined;
  try {
    facts = projectFactsOf(cwd, "red");
    plan = redShadowPlan(cwd, facts, emitProject(facts, generatedFileGlobs(cwd)));
    before = hashOrUndefined(cwd);
    dir = materializeShadow(cwd, plan);
  } catch (e) {
    return gateError(cwd, (e instanceof Error ? e.message : String(e)).replace(/^red-gate: /, ""), "shadow-project");
  }

  // Again, now that the shadow holds its copy: a config change between the
  // first check and the copy would otherwise run.
  const copiedBlock = configDriftBlock(GUARD, cwd);
  if (copiedBlock !== undefined) return copiedBlock;

  const policy = phaseRun(cwd, "red");
  if (policy.refusals.length > 0) return gateError(cwd, policy.refusals.join("; "), "test-policy");

  const [raw, tsc, testLint] = await Promise.all([
    runTests(dir, { ...gateOptionsFromEnv(), env: policy.env }),
    typecheck(dir, gateTypecheckOptionsFromEnv()),
    // Escape hatches in test sources: a suite that silences the type
    // checker can assert its way past anything.
    lintTests(cwd),
  ]);
  const { run, skipped } = withoutPolicySkips(raw, policy);
  let base = classifyRed(run, tsc, projectOwnerOf(cwd), pathGlobMatcher(generatedFileGlobs(cwd)));
  if (base.code === 0 && testLint.code === 1) {
    base = {
      code: 1,
      verdict: "block",
      summary: `${testLint.summary} in tests (route: test-writer)`,
      lines: [
        `red-gate: FAIL — the red is valid but the test sources switch the type checker off (${testLint.summary})`,
        ...testLint.lines.slice(0, -1),
        "red-gate: a non-null assertion, cast, any or ts-comment in a test helper undermines every assertion built on it",
        "red-gate: route → test-writer",
      ],
      detail: { reason: "test-escape-hatches", ...testLint.detail, route: "test-writer" },
    };
  }
  // Obligations are only meaningful once the red itself is valid.
  const judged = base.code === 0 ? withObligations(cwd, facts, base, run) : base;
  const skipLines = policy.skips.length > 0
    ? [...policy.skips.map((reason) => `red-gate: skipped — ${reason}`), ...(skipped.length > 0 ? [`red-gate: ${skipped.length} skipped test${skipped.length === 1 ? "" : "s"} not counted`] : [])]
    : [];
  const after = hashOrUndefined(cwd);
  if (before === undefined || before !== after) {
    return gateError(cwd, "the test-side files changed while the red ran, so it proves nothing about them; run red_gate again once they are still", "tests-moved");
  }
  const result: GateResult = { ...judged, lines: [...skipLines, ...judged.lines] };
  logGuardEvent(cwd, {
    guard: GUARD,
    verdict: result.verdict,
    summary: result.summary,
    detail: {
      ...result.detail,
      shadow: SHADOW_RELATIVE,
      contracts: facts.workspaces.reduce((n, w) => n + w.contracts.length, 0),
      ...(policy.skips.length > 0 ? { skips: policy.skips, skippedTests: skipped.length } : {}),
      ...redInputs(cwd, before),
    },
  });
  return result;
}

async function main(argv: string[]): Promise<number> {
  const result = await runRedGate(argv[0] ?? process.cwd());
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
      console.error(`red-gate: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
