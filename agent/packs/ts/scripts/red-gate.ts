// red gate (TN-26-001, TEST → BUILD boundary, §"Test-runner gates").
//
//   node red-gate.ts [targetDir]
//
// Runs the target project's vitest suite (JSON reporter, via the shared
// run_tests suite runner) AND `tsc --noEmit`, and asserts a VALID red: the
// project TYPECHECKS, the suite RUNS, every test fails, and EVERY failure is
// a NotImplementedError. Red only proves
// something if someone checks WHY it went red (see TN-26-001 Appendix,
// Böckeler). Wrong-reason red — import errors, config errors, type/runtime
// errors, ordinary assertion failures — is REJECTED, naming the offending
// test. A fully-passing suite at the red phase is ALSO a fail: nothing is
// waiting to be built.
//
// RED ALSO REQUIRES A TYPE-CLEAN PROJECT (issue #7). In Run 3 two type errors
// in a test file survived the whole TEST phase and only surfaced after a
// (false) green — by which point the only role that could fix them, the
// test-writer, had long been handed off. tests/** type errors are the
// test-writer's to fix and this is the last gate where that is cheap, so
// catch them here and print one greppable `route → <role>` line.
//
// THE GATE RUNS AGAINST A SHADOW PROJECT, NOT THE LIVE TREE. The verdict
// "every failure is a NotImplementedError" is only measurable against an
// unimplemented skeleton, so running on the live tree made red impossible the
// moment the builder wrote anything — which is why BUILD had to wait for TEST,
// and why the r13/r14 runs jammed with an implemented tree and no way back to
// red short of re-freezing the contracts to wipe src/. `scaffold` is
// deterministic and the contracts are checksum-frozen, so the skeleton can be
// reproduced at will: the gate rebuilds one at `<project>/.bounded/shadow-red/`
// from the contracts, the tests and the config, and runs every check there.
// The verdict then holds regardless of what src/ contains, so the test-writer
// and the builder are PARALLEL workers over disjoint write zones (tests/ and
// src/) rather than a sequence.
//
// Exit 0 valid red · 1 invalid red (one greppable line each) · 2 misuse
// (target unrunnable / bad invocation). Logs one guard event to the target's
// .bounded/guard-log.jsonl, carrying the contract manifest and the tests-tree hash
// the verdict was made against — green binds itself to both (green-gate.ts).
//
// The suite and tsc commands are injectable for testing via BOUNDED_GATE_TEST_CMD /
// BOUNDED_GATE_TEST_ARGS and BOUNDED_GATE_TSC_CMD / BOUNDED_GATE_TSC_ARGS (JSON arrays);
// defaults are `npx vitest run --reporter=json` and `npx tsc --noEmit`.

import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Project } from "ts-morph";
import {
  boundaryRemedyLines,
  calledNames,
  checkBoundaryBlocks,
  declaredExports,
  reachedNames,
  readContracts,
  readHandWrittenTests,
  readAllTests,
  unreachedExports,
  unreachedRemedyLines,
  valueObjectClasses,
} from "./test-obligations.ts";
import {
  ERRORS_MODULE_SOURCE,
  errorsModuleFor,
  isGeneratedArtifact,
  scaffoldContract,
  skeletonPathFor,
  componentTypeNames,
  contractSupportFor,
  shippedSupportSource,
} from "./scaffold-contract.ts";
import { computeManifest } from "./checksum-gate.ts";
import { runTests, type RunTestsOptions, type RunTestsResult } from "./run-tests.ts";
import { lintTests } from "./lint-src.ts";
import { typecheck, type TypecheckOptions, type TypecheckResult } from "./typecheck.ts";
import { mostUpstream, projectOwnerOf, routeTypecheck, typecheckLines, type OwnerOf } from "./typecheck-routing.ts";
import { UNREADABLE_LAYOUT, type PathLayout } from "../../../src/path-policy.ts";
import { logGuardEvent } from "../../../src/guard-log.ts";
import { containedSupportTargets } from "./support-targets.ts";
import { contractGlobs, fileNameGlobs, fileNameMatcher } from "../../../src/pack-contrib.ts";
import { readProjectPacks } from "../../../src/project-composition.ts";
import { configDriftBlock } from "./project-config.ts";
import type { GateResult } from "../../../src/gate-result.ts";

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
  const offenders = run.results.filter((r) => r.status === "failed" && !isNotImplementedFailure(r.message));
  if (offenders.length > 0) {
    // A FILE-level failure whose message mentions NotImplemented reads as a
    // contradiction — "the right error is the wrong reason?" — and it cost
    // Run 8's architect 25 minutes and five bounces against the wrong
    // hypothesis. It is not a contradiction: the throw happened during
    // import/collection, before any test ran. A skeleton call at the top
    // level of a test file (building fixtures outside `test()`) throws while
    // vitest is still collecting, so no test ever gets to fail for the right
    // reason. The gate is correct to block; the message must say WHY.
    const collectionFailures = offenders.filter(
      (o) => o.name === "(test file)" && o.message !== undefined && /NotImplemented/.test(o.message),
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
              "red-gate: a NotImplemented thrown by '(test file)' happened during IMPORT/COLLECTION, not in a test:",
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
export function classifyRed(
  run: RunTestsResult,
  tsc: TypecheckResult,
  /** Who owns each file: the composed layout or `projectOwnerOf(cwd)`. */
  ownership: PathLayout | OwnerOf = UNREADABLE_LAYOUT,
): GateResult {
  const suite = classifySuite(run);
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
    return suite.code === 0
      ? { ...suite, lines: [`${suite.lines[0]}, typecheck clean`, ...suite.lines.slice(1)] }
      : { ...suite, lines: [...suite.lines, "red-gate: route → test-writer"], detail: { ...suite.detail, route: "test-writer" } };
  }

  const plural = types.errorCount === 1 ? "" : "s";
  const headline =
    suite.code === 0
      ? [`red-gate: FAIL — ${types.errorCount} type error${plural}; red is valid but the project is not type-clean`]
      : suite.lines;
  // The test-writer owns anything wrong at TEST; a type error may point further up.
  const route = mostUpstream(["test-writer", ...types.owners]);
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

/** Test seam: override the suite command without spawning real vitest. */
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

/** What the shadow project is built from. */
export interface RedGateSources {
  /** Project-relative *.contract.ts paths. */
  readonly contracts: readonly string[];
  /** Project-relative test file paths. */
  readonly testFiles: readonly string[];
  /** Project-relative config the suite needs (package.json, tsconfig.json, …). */
  readonly configFiles: readonly string[];
  /** Implementation files that already exist. Never copied; listed only so the
   *  plan can be asserted to exclude them. */
  readonly implementationFiles?: readonly string[];
}

export interface RedGateProjectPlan {
  /** Files copied verbatim into the shadow project. */
  readonly copy: readonly string[];
  /** Contracts to re-scaffold there, producing the throwing skeletons. */
  readonly regenerate: readonly string[];
}

/**
 * Plan a shadow project in which the red gate is valid regardless of what the
 * builder has done to the real `src/`.
 *
 * The red gate asserts every failure is NotImplementedError, which is only
 * measurable against an UNIMPLEMENTED skeleton — and that is the sole reason
 * BUILD had to wait for TEST. Once the builder writes code the window shuts
 * forever.
 *
 * But that is an artifact of running against the live tree. `scaffold` is
 * deterministic and the contracts are checksum-frozen, so the skeleton can be
 * reproduced at will. Copy the contracts, the tests and the config into a
 * shadow project, regenerate the skeletons there, and run: the verdict holds no
 * matter what exists in the real src/. That lets the test-writer and the
 * builder work in parallel, turning the critical path from sum() into max().
 *
 * Blindness is untouched — regenerating a skeleton needs the contracts, never
 * the tests.
 */
export function redGateProjectPlan(sources: RedGateSources): RedGateProjectPlan {
  if (sources.contracts.length === 0) {
    throw new Error("red-gate: no contracts to regenerate — nothing to run the tests against");
  }
  if (sources.testFiles.length === 0) {
    throw new Error("red-gate: no tests found — a red is a positive claim, and silence is not one");
  }
  // Implementation files are deliberately absent: copying one is precisely the
  // bug this avoids, since it would let a partial implementation turn
  // NotImplemented failures into ordinary assertion failures.
  return {
    copy: [...sources.contracts, ...sources.testFiles, ...sources.configFiles],
    regenerate: [...sources.contracts],
  };
}

// --- Building the shadow project ------------------------------------------------

/** The root config files the shadow copies: every root file the composed
 *  packs' `projectConfigNames` name (ADR 2026-054), so the shadow runs with
 *  the same test-runner, compiler and bundler config as the live tree (a
 *  web composition's Vite plugins included). The pack data is the one list;
 *  an unreadable composition throws, and the gate reports it as an error. */
function rootConfigFiles(cwd: string): string[] {
  const isConfig = fileNameMatcher(fileNameGlobs("projectConfigNames", readProjectPacks(cwd)));
  return readdirSync(cwd, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isConfig(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Project-relative paths, POSIX separators, of every *.ts / *.tsx under `dir`.
 *
 *  `.tsx` is a first-class test and implementation extension (TN-26-006 A1),
 *  and this walk decides what the shadow project is BUILT FROM. A component
 *  test the walk cannot see is a test the shadow never copies — so the red
 *  would be measured over a suite with a hole in it and report the number of
 *  tests it happened to find as if that were all of them. Contracts stay
 *  `.contract.ts`, so the filter below is unaffected. */
function walkTs(root: string, dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(root, full, out);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
  return out;
}

/** Project-relative paths, POSIX separators, of every file under `dir`.
 *  `node_modules` and dot entries are skipped — the latter so that the shadow
 *  project under `.bounded/`, which holds a copy of these very files, can never
 *  find its way into the hash of the tree it was built from. */
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

/**
 * A deterministic fingerprint of the tests tree.
 *
 * sha256 over every file under `tests/`, sorted by project-relative POSIX
 * path; each file contributes its path and its newline-normalized content,
 * NUL-separated so no rename can be disguised as a content change or vice
 * versa. Newline normalization matches `hashContract` — CRLF/LF churn is not
 * an edit. Every file counts, not just `*.ts`: a JSON fixture the suite reads
 * is as much a part of what the red proved as the assertions are.
 *
 * This is what binds a green to a red (see green-gate.ts). The red proves
 * THESE tests can fail; a test edited afterwards is unproven, and a green over
 * an unproven suite is the Run 10 false green wearing a different hat. An
 * absent `tests/` hashes to the empty digest, which is honest — there is
 * nothing there — and red would have refused such a project anyway.
 */
export function testsTreeHash(cwd: string): string {
  const hash = createHash("sha256");
  for (const rel of walkFiles(cwd, join(cwd, "tests")).sort()) {
    hash.update(rel, "utf8");
    hash.update("\0");
    hash.update(readFileSync(join(cwd, rel), "utf8").replace(/\r\n/g, "\n"), "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** What the shadow project is built from, read off the live tree. Contracts and
 *  tests are found the same way the rest of the pack finds them; implementation
 *  files are listed only so the plan can be asserted to exclude them. */
export function collectRedGateSources(cwd: string): RedGateSources {
  const src = walkTs(cwd, join(cwd, "src"));
  return {
    contracts: src.filter((f) => f.endsWith(".contract.ts")),
    testFiles: walkTs(cwd, join(cwd, "tests")),
    configFiles: rootConfigFiles(cwd),
    implementationFiles: src.filter((f) => !f.endsWith(".contract.ts")),
  };
}

/** Where the shadow project lives, relative to the target project. Inside
 *  `.bounded/`, which delivery already gitignores, so a shadow can never reach a
 *  commit. */
export const SHADOW_RELATIVE = ".bounded/shadow-red";

/** Absolute path of the shadow project for `cwd`. Absolute deliberately: the
 *  suite and the type checker are spawned WITH this as their working
 *  directory, and vitest refuses a relative one — so `red-gate.ts .` must not
 *  hand them `./.bounded/shadow-red`. */
export function shadowProjectDir(cwd: string): string {
  return resolve(cwd, SHADOW_RELATIVE);
}

/**
 * Materialize a plan into the shadow project and return its path.
 *
 * WIPED AND REBUILT ON EVERY INVOCATION. A shadow that accumulates is a shadow
 * that can go stale, and a stale shadow is a verdict about a project that no
 * longer exists — the one thing a deterministic gate must never produce. Full
 * rebuild is cheap (a handful of copies plus the scaffolder) and it makes the
 * run's inputs a pure function of the live tree.
 *
 * It is LEFT BEHIND when the gate finishes, deliberately. A red that failed for
 * a reason the output does not explain is diagnosed by looking at the project
 * it actually ran against, and a directory that deletes itself is a postmortem
 * you cannot do. Nothing reads it back — the next run rebuilds from scratch —
 * so leaving it costs disk and buys evidence.
 *
 * `node_modules` is symlinked rather than copied: the suite needs vitest and
 * typescript, and a copy would cost more than the gate saves. The wipe unlinks
 * that symlink rather than following it, so the project's real modules are
 * never touched.
 *
 * The skeletons are REGENERATED here, never copied — that is the whole point.
 * `scaffold` is deterministic and the contracts are checksum-frozen, so the
 * unimplemented skeleton can be reproduced at any moment, which is what makes
 * the verdict independent of whatever the builder has done to the real src/.
 */
export function materializeShadowProject(cwd: string, plan: RedGateProjectPlan): string {
  const names = componentTypeNames(cwd);
  const supportFiles = contractSupportFor(cwd);
  const dir = shadowProjectDir(cwd);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  for (const rel of plan.copy) {
    const to = join(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(cwd, rel), to);
  }

  const modules = join(cwd, "node_modules");
  if (existsSync(modules)) {
    try {
      symlinkSync(modules, join(dir, "node_modules"), "dir");
    } catch {
      // A missing symlink is not fatal on its own — the suite will fail to run
      // and classifySuite reports that as a wrong-reason red, which is true.
    }
  }

  for (const rel of plan.regenerate) {
    const source = readFileSync(join(cwd, rel), "utf8");
    // Same source, same extension decision as the live tree's scaffold step:
    // a component contract's skeleton is a `.tsx` here too (TN-26-006 A1). The
    // shadow is only evidence if it is the project the live scaffold would have
    // produced, and a skeleton at a different path is a different project.
    const skeleton = join(dir, skeletonPathFor(rel, source, names));
    mkdirSync(dirname(skeleton), { recursive: true });
    writeFileSync(skeleton, scaffoldContract(source, rel), "utf8");

    const errors = join(dir, errorsModuleFor(rel) + ".ts");
    if (!existsSync(errors)) {
      mkdirSync(dirname(errors), { recursive: true });
      writeFileSync(errors, ERRORS_MODULE_SOURCE, "utf8");
    }

    // Recreate shipped, contract-triggered support code from the composed
    // packs (ADR 2026-046). It is neither a business implementation nor a
    // live-tree copy: the same frozen contract and canonical source produce the
    // same file in both projects. A pack the project did not compose ships
    // nothing here, exactly as it ships nothing to the live tree.
    for (const support of supportFiles) {
      const asked = containedSupportTargets(support, source, rel, dir);
      if (!asked.ok) throw new Error(`red-gate: ${asked.reason}`);
      for (const target of asked.targets) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, shippedSupportSource(support), "utf8");
      }
    }
  }

  return dir;
}

/**
 * A contract can borrow the inferred type of a value that the builder adds to
 * its sibling implementation (`import type { serviceRouter } from "./api.js"`).
 * The shadow skeleton intentionally lacks that extra value. Accept only the
 * resulting missing-export diagnostic, and only after the full live project
 * typechecks. No declaration or `any` stand-in is inserted into the shadow:
 * tests still execute only against throwing code.
 */
export function isForwardTypeImportDiagnostic(cwd: string, diagnostic: string): boolean {
  const forward = forwardTypeImport(cwd, diagnostic);
  if (forward === undefined) return false;
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("implementation.ts", forward.implementationSource).getExportedDeclarations().has(forward.name);
}

/**
 * The same forward import at FIRST freeze, before any builder exists: the
 * sibling is still the generated skeleton, which cannot carry a value only
 * the builder writes. The red gate's shadow and the green gate's clean
 * typecheck both still require the export once it is built.
 */
export function isSkeletonForwardTypeImportDiagnostic(cwd: string, diagnostic: string): boolean {
  const forward = forwardTypeImport(cwd, diagnostic);
  return forward !== undefined && isGeneratedArtifact(forward.implementationSource);
}

/** A TS2724 on a type-only named import, in a contract, of its own sibling implementation. */
function forwardTypeImport(cwd: string, diagnostic: string): { readonly name: string; readonly implementationSource: string } | undefined {
  const match = /^(.+\.contract\.ts)\((\d+),\d+\): error TS2724: '\"([^\"]+)\"' has no exported member named '([^']+)'\./.exec(diagnostic);
  if (!match) return undefined;
  const [, contractRel, lineText, quotedModule, name] = match;
  if (!contractRel || !lineText || !quotedModule || !name) return undefined;
  const contract = resolve(cwd, contractRel);
  if (!contract.startsWith(`${resolve(cwd)}${sep}`) || !existsSync(contract)) return undefined;
  const sibling = `./${contractRel.split("/").at(-1)!.replace(/\.contract\.ts$/, ".js")}`;
  if (quotedModule !== sibling) return undefined;
  const implementation = resolve(dirname(contract), sibling.replace(/\.js$/, ".ts"));
  if (!existsSync(implementation)) return undefined;

  const project = new Project({ useInMemoryFileSystem: true });
  const contractAst = project.createSourceFile("contract.ts", readFileSync(contract, "utf8"));
  const line = Number(lineText);
  const forwardImport = contractAst.getImportDeclarations().some((declaration) =>
    declaration.isTypeOnly() && declaration.getModuleSpecifierValue() === sibling &&
    declaration.getNamedImports().some((named) =>
      named.getName() === name && named.getNameNode().getStartLineNumber() === line,
    ),
  );
  return forwardImport ? { name, implementationSource: readFileSync(implementation, "utf8") } : undefined;
}

export async function typecheckShadowWithForwardImports(cwd: string, shadow: string): Promise<TypecheckResult> {
  const shadowResult = await typecheck(shadow, gateTypecheckOptionsFromEnv());
  if (shadowResult.errorCount === 0 || shadowResult.diagnostics.length === 0) return shadowResult;
  if (!shadowResult.diagnostics.every((line) => isForwardTypeImportDiagnostic(cwd, line))) return shadowResult;
  const liveResult = await typecheck(cwd, gateTypecheckOptionsFromEnv());
  return liveResult.ok && liveResult.errorCount === 0
    ? { ok: true, errorCount: 0, diagnostics: [] }
    : liveResult;
}

/**
 * The two obligations a red must ALSO discharge, checked only once the red is
 * otherwise valid.
 *
 * Dogfood Run 7 is why both exist. Its suite was a right-reason red, type-clean,
 * 32 tests — and it never called 9 of the contract's 15 exports. Every value
 * object parser went untested through a red gate and a green gate, because the
 * gates asked whether the failures were the right KIND and never whether they
 * covered the SURFACE. The measurement was already in hand: the scaffolder
 * writes the export's own name into each NotImplementedError, and the gate was
 * throwing that name away.
 *
 *   · REACHABILITY is exact and free — set difference over data already parsed.
 *     An export no failure names is an export no test called.
 *   · BOUNDARIES is a fingerprint, not a measurement. It eliminates OMISSION —
 *     nine parsers, zero assertions, no intent involved — and not evasion; a
 *     lazy pair of rejections satisfies it. Claim no more for it than that.
 *
 * Both are the test-writer's to fix, and this is the last gate where fixing
 * them is cheap.
 */
function withObligations(cwd: string, base: GateResult, run: RunTestsResult): GateResult {
  let contracts, tests;
  try {
    contracts = readContracts(cwd);
    tests = readHandWrittenTests(cwd);
  } catch {
    return base; // an unreadable tree must never turn a valid red into a block
  }

  // Call sites in the test sources are the PRIMARY reachability evidence;
  // red-phase failure names only corroborate. An export whose inputs come from
  // other exports can never surface in a red failure — every test dies at the
  // first skeleton call — and Run 9 jammed five bounces deep on exactly that.
  const reached = new Set([
    ...reachedNames(run.results.filter((r) => r.status === "failed").map((r) => r.message)),
    ...calledNames(readAllTests(cwd)),
  ]);
  const unreached = unreachedExports(declaredExports(contracts), reached);
  const boundaries = checkBoundaryBlocks(valueObjectClasses(contracts), tests);
  if (unreached.length === 0 && boundaries.length === 0) return base;

  const counts = [
    unreached.length > 0 ? `${unreached.length} unreached export${unreached.length === 1 ? "" : "s"}` : undefined,
    boundaries.length > 0 ? `${boundaries.length} boundaries gap${boundaries.length === 1 ? "" : "s"}` : undefined,
  ].filter((c) => c !== undefined);

  return {
    code: 1,
    verdict: "block",
    summary: `${counts.join(" + ")} (route: test-writer)`,
    lines: [
      `red-gate: FAIL — the red is valid but incomplete: ${counts.join(", ")}`,
      ...(unreached.length > 0 ? unreachedRemedyLines(unreached) : []),
      ...boundaries.flatMap((v) => boundaryRemedyLines(v)),
      "red-gate: route → test-writer",
    ],
    detail: {
      reason: "obligations",
      unreached: unreached.map((u) => u.name),
      boundaries: boundaries.map((v) => ({ className: v.className, kind: v.kind })),
      route: "test-writer",
    },
  };
}

/**
 * The inputs this verdict is a claim ABOUT, recorded so a later gate can bind
 * itself to them: the contract manifest (checksum-gate's own `computeManifest`,
 * so "the contracts the red ran against" has exactly one definition) and the
 * tests-tree hash. Green reads both back — a red is worth nothing once the
 * things it was measured over have moved.
 *
 * Best effort: an unreadable tree must never turn a valid red into an error.
 */
function redInputs(cwd: string): Record<string, unknown> {
  try {
    return { contractManifest: computeManifest(cwd).files, testsTreeHash: testsTreeHash(cwd) };
  } catch {
    return {};
  }
}

/** Run the red gate and return its verdict without printing or exiting.
 *  The `red_gate` tool and the CLI below are both thin wrappers over this, so
 *  there is exactly one implementation of "is this a valid red".
 *
 *  Every check runs in the SHADOW PROJECT at `.bounded/shadow-red/`, rebuilt from
 *  the contracts, the tests and the config on each invocation — not the live
 *  tree. A valid red asserts every failure is NotImplementedError, which is
 *  only measurable against an unimplemented skeleton — running against the live
 *  tree is what forced BUILD to wait for TEST, because the window shut the
 *  moment the builder wrote anything. Against a regenerated shadow the verdict
 *  holds regardless, so the test-writer and the builder run concurrently over
 *  disjoint write zones.
 *
 *  Blindness is untouched: regenerating a skeleton needs the contracts, never
 *  the tests. */
export async function runRedGate(cwd: string): Promise<GateResult> {
  // The shadow copies and runs the project's config: it must be what the
  // composed packs generate (ADR 2026-054).
  const configBlock = configDriftBlock(GUARD, cwd);
  if (configBlock !== undefined) return configBlock;
  let dir: string;
  let plan: RedGateProjectPlan;
  try {
    plan = redGateProjectPlan(collectRedGateSources(cwd));
    dir = materializeShadowProject(cwd, plan);
  } catch (e) {
    const summary = e instanceof Error ? e.message : String(e);
    const result: GateResult = {
      code: 2,
      verdict: "error",
      summary,
      lines: [`red-gate: ERROR — ${summary}`],
      detail: { reason: "shadow-project" },
    };
    logGuardEvent(cwd, { guard: GUARD, verdict: result.verdict, summary, detail: result.detail });
    return result;
  }

  // Again, now that the shadow holds its copy: the suite runs in the shadow,
  // where runTests' own drift check cannot see the live tree, so a config
  // change between the first check and the copy would otherwise run.
  const copiedBlock = configDriftBlock(GUARD, cwd);
  if (copiedBlock !== undefined) return copiedBlock;
  const [run, tsc, testLint] = await Promise.all([
    runTests(dir, gateOptionsFromEnv()),
    typecheckShadowWithForwardImports(cwd, dir),
    // Escape hatches in TEST sources: a suite that silences the type
    // checker can assert its way past anything, and Run 10's helpers used
    // `!` freely because only src/** was watched. Checked here because this
    // is the last gate where the fix is cheap and the test-writer is live.
    lintTests(cwd),
  ]);
  let base = classifyRed(run, tsc, projectOwnerOf(cwd));
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
  // Obligations are only meaningful once the red itself is valid: against a
  // broken suite "nothing reached parseCurrency" is noise, not a finding.
  const result = base.code === 0 ? withObligations(cwd, base, run) : base;
  logGuardEvent(cwd, {
    guard: GUARD,
    verdict: result.verdict,
    summary: result.summary,
    detail: {
      ...result.detail,
      shadow: SHADOW_RELATIVE,
      contracts: plan.regenerate.length,
      ...redInputs(cwd),
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
