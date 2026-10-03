// Mutation score (TN-26-002, "Mutation matrix"): how much of the delivered
// logic does the suite actually hold down?
//
//   node mutation-score.ts [targetDir] [--max-mutants N] [--timeout-ms N]
//
// Crash safety, the sample and the time budget are ADR 2026-070 (issue #48).
//
// THIS IS A MEASUREMENT, NOT A GATE. It always exits 0 when the measurement
// ran, whatever the score — nothing here blocks a phase transition. A
// threshold ("fail under 80%") is a one-line addition on top of
// `MutationScoreResult.score` and is deliberately not made yet: the first job
// is to find out what scores real runs produce, and a gate set before the
// distribution is known is a guess wearing a uniform. Exit 2 is reserved for
// misuse — a target that is not a project, or a suite that is not green
// before mutation (a score against a red suite means nothing).
//
// --- why this exists ------------------------------------------------------------
//
// TN-26-002 compared six suites (three models × harness/guidance) by hand:
// two mutants — proration rounding corrupted, idempotent-replay guard removed
// — dropped into each suite, counting how many tests failed. "Killed" meant
// the suite went red. Every suite killed both mutants, and the kill COUNTS
// tracked the model, not the methodology. The note's own caveat: "two mutants,
// one domain — a mutation-score gate would make this a standing measurement."
//
// This is that mechanization. Same idea, same verdict rule (killed = the suite
// goes red), applied per run to whatever the run produced instead of to two
// hand-written edits in one billing domain. What it buys over the hand matrix
// is comparability: the same operators, the same deterministic selection, the
// same score arithmetic, across every run and every model.
//
// It is NOT exhaustive mutation testing, and is not trying to be. Stryker
// exists. This is a small, fixed, documented operator set aimed at exactly
// where TN-26-002 aimed by hand — arithmetic-and-guard logic at the parse
// boundary — so that the number means the same thing in run 20 as in run 10.
//
// --- the operator set (four operators, deliberately small) ----------------------
//
//   1. comparison flip   `<`↔`<=`, `>`↔`>=`, `===`↔`!==`
//        Off-by-one and inverted-sense defects. This is the mechanical form of
//        TN-26-002's "proration rounding corrupted": a boundary that moves by
//        one, which only a test asserting AT the boundary can see.
//   2. logical swap      `&&`↔`||`
//        A conjunction of validity conditions turned into a disjunction —
//        every rejection rule but one stops being load-bearing.
//   3. if-negation       `if (c)` → `if (!(c))`
//        The guard fires exactly when it should not. The bluntest possible
//        version of "the guard is wrong".
//   4. guard fall-through  `return undefined;` or a failed Result
//        (`return { ok: false, … };`) → `;` inside a parse-shaped function's
//        early-return guard
//        The mechanical form of TN-26-002's "idempotent-replay guard removed":
//        the check still runs, its rejection just stops happening, and control
//        falls into the happy path. Restricted (see below) so it always
//        changes behaviour.
//
// Nothing else. No arithmetic-operator swaps, no literal tweaks, no statement
// deletion, no return-value replacement — those find defects this harness's
// gates already look for elsewhere, and every operator added is a number that
// stops being comparable to the numbers already recorded.
//
// The guard fall-through operator is the only one with a shape restriction,
// because it is the only one that can silently produce an EQUIVALENT mutant (a
// change with no observable effect, which survives for a reason that is not
// the suite's fault and so quietly deflates the score). Dropping
// `return undefined` from the LAST statement of a function changes nothing —
// the function returns undefined anyway. So the site only counts when the
// return sits inside an `if` that is a top-level statement of the function
// body AND that `if` is not the last statement: then, and only then, dropping
// the return lets control reach code it could not reach before.
//
// --- what is mutated ------------------------------------------------------------
//
// Every `.ts` file under the composed source roots (ADR 2026-056), minus:
//   - `*.contract.ts`         — declaration-only by lint; nothing to mutate,
//                               and the checksum gate owns them anyway.
//   - test-side files         — the suite is the thing being measured
//                               (`testFileSuffixes`, ADR 2026-057).
//   - generated files         — `generatedFileGlobs` (ADR 2026-058): barrels,
//                               commands, in-adapters, migrations. Mutating
//                               them measures the generator, not the builder.
//   - `**/index.ts`           — re-export hubs; no logic.
//   - skeleton leftovers      — a file still constructing NotImplementedError
//                               is red-phase scaffolding that survived to
//                               measurement time.
//
// --- the sample (deterministic, so runs are comparable) -------------------------
//
// Sites are collected in (file path, source offset) order, and the sample is
// taken SYSTEMATICALLY over that list: evenly spaced indices
// floor(i × sites ÷ sample). Each file gets mutants in proportion to the sites
// it holds, a sample smaller than the file count still reaches the whole tree
// (round-robin across files, the old rule, only ever reached the
// alphabetically first files), and two runs over the same tree pick the same
// mutants.
//
// The sample is at least MINIMUM_SAMPLE (40) mutants, or every site when
// there are fewer. A score's precision depends on how many mutants it holds,
// not on what share of the sites they are, so the minimum is a count, not a
// proportion; 40 was the old default, so recorded scores stay comparable.
// `--max-mutants` raises the sample; asking for fewer than the minimum is
// misuse (a 10-of-397 sample is the meaningless score issue #48 reported).
// The report puts the sample size and the site count beside the score.
//
// --- the loop -------------------------------------------------------------------
//
// One mutant at a time: write the restore journal (mutation-journal.ts: the
// original bytes and what is about to change, outside the source roots),
// splice the replacement into the file at the AST's offsets, run the suite
// through the run-tests seam, restore the file from the bytes read before the
// edit, VERIFY the restore by comparing buffers — the target is the user's
// repo, and "we wrote it back" is not evidence — and only then clear the
// journal. The restore is in a `finally`, so it happens even when the suite
// runner throws; a runner that throws aborts the whole measurement rather
// than being scored, because a broken runner is a broken environment, not a
// property of the mutant. A restore that does not verify is fatal for the
// same reason, and leaves the journal for the next gate to act on.
//
// What a `finally` cannot cover: SIGINT and SIGTERM are handled here, for the
// length of the loop (restore the file in flight, verify, clear the journal,
// log `interrupted`, then die of the same signal); SIGKILL is the journal's
// case. Before collecting sites, a run restores what an earlier, killed run
// left — as every ts gate does before it runs.
//
// --- the time budget, and continuing across calls -------------------------------
//
// A host kills a command that outlives its limit (Claude Code: the call's
// timeout, at most 10 minutes), and a killed run judged nothing. With a budget
// (`budgetMs`; the registry derives it from the host's command deadline,
// BOUNDED_COMMAND_TIMEOUT_MS), a mutant is started only when its full timeout
// still fits; otherwise the run stops cleanly and reports PARTIAL with no
// score. Every verdict is saved under .bounded/mutation-score/ as it is
// reached, keyed by a fingerprint of the sample, the per-mutant timeout and
// every file under the source roots and every test-side file; the next run
// over an unchanged tree continues from there without re-running the baseline
// (the fingerprint proves the tree it was green against). Any change starts
// the sample over. Without a budget (pi, a bare shell) the whole sample runs
// in one call.
//
// A suite that times out counts as KILLED and is listed separately: a mutant
// that hangs the suite changed behaviour, and calling it a survivor would be
// the wrong kind of wrong.
//
// The suite runner is injectable (`options.runSuite`), which is how the tests
// exercise the whole loop without spawning bun 40 times. The real one is the
// run_tests runner (bun test, JUnit, ADR 2026-062) under the composed phase
// test policies at `green` (ADR 2026-064): store tests are never skipped, and
// with no container runtime to run them the measurement refuses.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { generatedFileGlobs, hasTestFileSuffix, pathGlobMatcher, sourceRoots, testFileSuffixes } from "../../../src/pack-contrib.ts";
import { expandSourceRoots } from "../../../src/path-gate.ts";
import { phaseRun, type PhaseRun, withPreparedServices } from "./phase-policy.ts";
import { fileURLToPath } from "node:url";
import { Node, Project, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { logGuardEvent, type GuardVerdict } from "../../../src/guard-log.ts";
import { runTests, spawnRunner, testFiles } from "./run-tests.ts";
import { configDriftBlock } from "./project-config.ts";
import { clearJournal, MUTATION_STATE_DIR, PROGRESS_FILE, restoreLeftoverMutant, writeAtomically, writeJournal } from "./mutation-journal.ts";

const GUARD = "mutation-score";

/** The smallest sample a score is reported on (every site when there are
 *  fewer). Each mutant costs a full suite run; the budget, not a lower cap,
 *  is what keeps one call short. */
export const MINIMUM_SAMPLE = 40;
/** Default per-mutant suite timeout. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** A red-phase skeleton still throws the not-implemented error. */
const SKELETON_THROW = /\bnew\s+NotImplementedError\s*\(/;

export class MutationScoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationScoreError";
  }
}

// --- mutant sites (pure core) ---------------------------------------------------

/** The four operators. Named so a report line, a guard-log entry and this
 *  file's documentation all say the same word. */
export type MutationOperator = "comparison" | "logical" | "if-negation" | "guard-fall-through";

export interface MutantSite {
  /** Project-relative posix path of the file to mutate. */
  readonly file: string;
  /** 1-based line of the mutated text, for the report line. */
  readonly line: number;
  /** Character offsets of the text this mutant replaces. */
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly operator: MutationOperator;
  /** Human-readable "before → after", e.g. `=== → !==`. */
  readonly label: string;
}

/** `<` ↔ `<=`, `>` ↔ `>=`, `===` ↔ `!==` — both directions of each pair. */
const COMPARISON_FLIPS: Readonly<Record<string, string | undefined>> = {
  "<": "<=",
  "<=": "<",
  ">": ">=",
  ">=": ">",
  "===": "!==",
  "!==": "===",
};

/** `&&` ↔ `||`. Compound assignment (`&&=`, `||=`) has different token text
 *  and is therefore untouched. */
const LOGICAL_SWAPS: Readonly<Record<string, string | undefined>> = { "&&": "||", "||": "&&" };

function isFunctionLike(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node)
  );
}

/** The name a function-like node is known by — its own, or the declaration it
 *  is assigned to. Undefined when it is anonymous. */
function functionLikeName(fn: Node): string | undefined {
  if (Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn)) return fn.getName();
  if (Node.isMethodDeclaration(fn)) return fn.getName();
  if (Node.isArrowFunction(fn)) {
    const parent = fn.getParent();
    if (parent === undefined) return undefined;
    if (Node.isVariableDeclaration(parent)) return parent.getName();
    if (Node.isPropertyDeclaration(parent)) return parent.getName();
    if (Node.isPropertyAssignment(parent)) return parent.getName();
  }
  return undefined;
}

function functionBody(fn: Node): Node | undefined {
  if (
    Node.isFunctionDeclaration(fn) ||
    Node.isMethodDeclaration(fn) ||
    Node.isFunctionExpression(fn) ||
    Node.isArrowFunction(fn)
  ) {
    return fn.getBody();
  }
  return undefined;
}

/**
 * Every mutant site in one source file, in source order.
 *
 * Pure: source text in, sites out. `fileRel` is only ever used as the site's
 * reported path and the in-memory file name — nothing is read from disk.
 */
export function mutantSites(source: string, fileRel: string): MutantSite[] {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sf = project.createSourceFile(basename(fileRel), source, { overwrite: true });
  const sites: MutantSite[] = [];

  const at = (start: number, end: number, replacement: string, operator: MutationOperator, label: string): void => {
    sites.push({
      file: fileRel,
      line: sf.getLineAndColumnAtPos(start).line,
      start,
      end,
      replacement,
      operator,
      label,
    });
  };

  // 1 + 2: binary operator tokens.
  for (const binary of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const token = binary.getOperatorToken();
    const text = token.getText();
    const flipped = COMPARISON_FLIPS[text];
    if (flipped !== undefined) {
      at(token.getStart(), token.getEnd(), flipped, "comparison", `${text} → ${flipped}`);
      continue;
    }
    const swapped = LOGICAL_SWAPS[text];
    if (swapped !== undefined) {
      at(token.getStart(), token.getEnd(), swapped, "logical", `${text} → ${swapped}`);
    }
  }

  // 3: if-conditions.
  for (const ifStatement of sf.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const condition = ifStatement.getExpression();
    at(
      condition.getStart(),
      condition.getEnd(),
      `!(${condition.getText()})`,
      "if-negation",
      "if (c) → if (!(c))",
    );
  }

  // 4: parse-shaped early-return guards (see the header for the restriction).
  sites.push(...guardFallThroughSites(sf, fileRel));

  return sites.sort((a, b) => a.start - b.start || a.operator.localeCompare(b.operator));
}

/** Is this the rejection a parse returns: `undefined`, or a failed Result
 *  (an object literal with `ok: false`, ADR 2026-059)? */
function isRejection(expression: Node): boolean {
  if (expression.getText() === "undefined") return true;
  if (!Node.isObjectLiteralExpression(expression)) return false;
  const ok = expression.getProperty("ok");
  return ok !== undefined && Node.isPropertyAssignment(ok) && ok.getInitializer()?.getText() === "false";
}

function guardFallThroughSites(sf: SourceFile, fileRel: string): MutantSite[] {
  const sites: MutantSite[] = [];
  for (const ret of sf.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    const expression = ret.getExpression();
    if (expression === undefined || !isRejection(expression)) continue;

    const fn = ret.getFirstAncestor(isFunctionLike);
    if (fn === undefined) continue;
    const name = functionLikeName(fn);
    if (name === undefined || !/^parse/i.test(name)) continue;

    const body = functionBody(fn);
    if (body === undefined || !Node.isBlock(body)) continue;
    const statements = body.getStatements();

    // The function-body statement this return lives inside must be an `if`
    // (it is a guard) with something after it (there is somewhere to fall to).
    const index = statements.findIndex((s) => s.getStart() <= ret.getStart() && ret.getEnd() <= s.getEnd());
    if (index === -1 || index === statements.length - 1) continue;
    if (!Node.isIfStatement(statements[index]!)) continue;

    sites.push({
      file: fileRel,
      line: sf.getLineAndColumnAtPos(ret.getStart()).line,
      start: ret.getStart(),
      end: ret.getEnd(),
      replacement: ";",
      operator: "guard-fall-through",
      label: expression.getText() === "undefined" ? "drop `return undefined` guard" : "drop `return { ok: false }` guard",
    });
  }
  return sites;
}

// --- file selection (pure core) -------------------------------------------------

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** What decides a file is not the builder's logic. */
export interface MutableLayout {
  /** Composed test-side suffixes (ADR 2026-057). */
  readonly testSuffixes: readonly string[];
  /** Is a project path generated (ADR 2026-058)? */
  readonly isGenerated: (path: string) => boolean;
}

/** Should this file be mutated? See the header for why each exclusion exists. */
export function isMutableSourceFile(relPath: string, source: string, layout: MutableLayout): boolean {
  if (!relPath.endsWith(".ts") || relPath.endsWith(".d.ts")) return false;
  if (relPath.endsWith(".contract.ts")) return false;
  if (hasTestFileSuffix(relPath, layout.testSuffixes) || layout.isGenerated(relPath)) return false;
  if (basename(relPath) === "index.ts") return false;
  if (SKELETON_THROW.test(source)) return false;
  return true;
}

/** All .ts files under `dir`, as project-relative posix paths, sorted. */
function tsFilesUnder(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", ".bounded"].includes(entry.name)) walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(toPosix(relative(root, full)));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The sample: `size` sites at evenly spaced indices floor(i × n ÷ size) of
 * `sites`, which must already be in (file, offset) order. Every file gets
 * mutants in proportion to its sites, the output keeps the input's order,
 * and the same input always gives the same sample — the whole point of a
 * standing measurement. A size of at least `sites.length` is every site.
 */
export function selectMutants(sites: readonly MutantSite[], size: number): MutantSite[] {
  if (size <= 0) return [];
  if (size >= sites.length) return [...sites];
  const picked: MutantSite[] = [];
  for (let i = 0; i < size; i++) picked.push(sites[Math.floor((i * sites.length) / size)]!);
  return picked;
}

// --- the suite seam -------------------------------------------------------------

/** What one suite run tells the measurement. */
export interface SuiteOutcome {
  /** True only when the suite ran AND every test passed. */
  readonly ok: boolean;
  /** Short human note for the report ("green", "3 failed", "timeout"). */
  readonly note: string;
  /** The run was cut off by the per-mutant timeout. */
  readonly timedOut?: boolean;
  /** Every failure was the machine's, not the code's (the policies'
   *  infrastructure classifiers): the causes. Such a run judges nothing. */
  readonly infrastructure?: readonly string[];
}

/** Runs the target's suite once, in the test environment `env` (the phase
 *  test policies' variables, services included). Injectable so tests never
 *  spawn bun. */
export type SuiteRunner = (
  cwd: string, timeoutMs: number, env: PhaseRun["env"], infrastructure?: PhaseRun["infrastructure"],
) => Promise<SuiteOutcome>;

/** The real runner: run_tests' bun runner, bounded by an AbortSignal, in the
 *  environment the gate prepared once for the whole measurement. */
export const bunSuiteRunner: SuiteRunner = async (cwd, timeoutMs, env, infrastructure) => {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const result = await runTests(cwd, {
      env,
      run: (command, args, dir, _signal, childEnv) => spawnRunner(command, args, dir, signal, childEnv),
    });
    if (!result.ok && infrastructure !== undefined) {
      const verdict = infrastructure([
        ...result.results.filter((r) => r.status === "failed").map((r) => ({ name: r.name, ...(r.message !== undefined ? { message: r.message } : {}), ...(r.file !== undefined ? { file: r.file } : {}) })),
        ...(result.unhandled !== undefined ? [{ name: "unhandled error", message: result.unhandled }] : []),
        ...(result.blocked !== undefined ? [{ name: "suite did not run", message: result.blocked }] : []),
      ]);
      if (verdict.all) return { ok: false, note: "the machine's failure", infrastructure: verdict.causes };
    }
    if (result.blocked !== undefined) return { ok: false, note: "suite blocked" };
    return { ok: result.ok, note: result.ok ? "green" : `${result.failed} failed` };
  } catch (e) {
    if (signal.aborted) return { ok: false, timedOut: true, note: `timeout after ${timeoutMs}ms` };
    throw e;
  }
};

/** A run with no policy at all: what an injected suite runner gets by default. */
const NO_POLICY: Pick<PhaseRun, "refusals" | "env" | "prepares"> & Partial<Pick<PhaseRun, "infrastructure">> = { refusals: [], env: { set: {}, unset: [] }, prepares: [] };

// --- runner ---------------------------------------------------------------------

export type MutantVerdict = "killed" | "survived" | "timeout";

export interface MutantOutcome {
  readonly site: MutantSite;
  readonly verdict: MutantVerdict;
  readonly note: string;
}

export interface MutationScoreOptions {
  /** The sample size. Default: the minimum sample; fewer is misuse. */
  readonly maxMutants?: number;
  /** The minimum sample (every site when there are fewer). Default
   *  {@link MINIMUM_SAMPLE}; the tests lower it for a 12-site fixture. */
  readonly minimumSample?: number;
  /** Per-mutant suite timeout in ms. Default {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** How long this call may take, in ms: a mutant (or the baseline) starts
   *  only while its full timeout still fits. Default: no limit. */
  readonly budgetMs?: number;
  /** The clock the budget is measured on. Default `Date.now`. */
  readonly now?: () => number;
  /** Suite runner. Default {@link bunSuiteRunner}. */
  readonly runSuite?: SuiteRunner;
  /** The phase test policies the whole measurement runs under. Default: the
   *  project's green policies with the default runner, none with an injected
   *  one. Services they prepare (a throwaway database) are started once,
   *  before the baseline, and released after the last mutant. */
  readonly policy?: Pick<PhaseRun, "refusals" | "env" | "prepares"> & Partial<Pick<PhaseRun, "infrastructure">>;
}

export interface MutationScoreResult {
  /** 0 whenever the measurement ran (whatever the score, complete or not);
   *  1 when something stopped it (a policy, the machine, a leftover mutant);
   *  2 for misuse. */
  readonly code: number;
  readonly lines: readonly string[];
  /** One line for the gate's summary: the headline, or why it did not run. */
  readonly summary: string;
  /** Total mutable sites found. */
  readonly sites: number;
  /** How many mutants the sample holds. */
  readonly sample: number;
  /** Every mutant of the sample is judged. False for a PARTIAL run, which
   *  reports no score; run it again to continue. */
  readonly complete: boolean;
  /** Every mutant judged so far, this call's and earlier calls' alike. */
  readonly outcomes: readonly MutantOutcome[];
  readonly killed: number;
  readonly survived: number;
  readonly timedOut: number;
  /** killed ÷ mutants as a whole-number percentage; only for a complete,
   *  non-empty sample. */
  readonly score?: number;
}

/** Verdict prefix, padded so the report reads as a column. */
const PREFIX_WIDTH = 8;

function reportLine(outcome: MutantOutcome): string {
  const verdict = outcome.verdict.toUpperCase().padEnd(PREFIX_WIDTH);
  const suffix = outcome.verdict === "timeout" ? " (counted as killed)" : "";
  return `${verdict} ${outcome.site.file}:${outcome.site.line} ${outcome.site.label}${suffix}`;
}

/** `4 mutants (sample) of 12 sites`, or `12 mutants of 12 sites (every site)`. */
function sampleWords(sample: number, sites: number): string {
  return sample < sites ? `${sample} mutants (sample) of ${sites} sites` : `${sample} mutants of ${sites} sites (every site)`;
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

// --- progress across calls --------------------------------------------------------

interface Progress {
  readonly version: 1;
  readonly fingerprint: string;
  /** Verdicts by index into the sample. */
  readonly verdicts: readonly { readonly index: number; readonly verdict: MutantVerdict; readonly note: string }[];
}

/** Every file under `dir`, project-relative posix paths (state and
 *  dependency directories skipped). */
function allFilesUnder(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", ".bounded"].includes(entry.name)) walk(full);
      } else if (entry.isFile()) {
        out.push(toPosix(relative(root, full)));
      }
    }
  };
  walk(dir);
  return out;
}

/** What a saved verdict was reached against: the sample, the per-mutant
 *  timeout, every file under the source roots and every test-side file. */
function sampleFingerprint(cwd: string, roots: readonly string[], mutants: readonly MutantSite[], timeoutMs: number): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ timeoutMs, mutants: mutants.map((m) => [m.file, m.start, m.end, m.replacement]) }));
  const files = new Set<string>();
  for (const root of roots) for (const rel of allFilesUnder(cwd, join(cwd, root))) files.add(rel);
  for (const test of testFiles(cwd)) files.add(test.path);
  for (const rel of [...files].sort()) {
    hash.update(`\0${rel}\0`);
    hash.update(readFileSync(join(cwd, rel)));
  }
  return hash.digest("hex");
}

function readProgress(cwd: string, fingerprint: string, sample: number): Map<number, { verdict: MutantVerdict; note: string }> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(cwd, PROGRESS_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const p: Record<string, unknown> = { ...raw };
  if (p["version"] !== 1 || p["fingerprint"] !== fingerprint || !Array.isArray(p["verdicts"])) return undefined;
  const verdicts = new Map<number, { verdict: MutantVerdict; note: string }>();
  for (const item of p["verdicts"] as unknown[]) {
    if (typeof item !== "object" || item === null) return undefined;
    const v: Record<string, unknown> = { ...item };
    const index = v["index"];
    const verdict = v["verdict"];
    const note = v["note"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= sample) return undefined;
    if (verdict !== "killed" && verdict !== "survived" && verdict !== "timeout") return undefined;
    if (typeof note !== "string") return undefined;
    verdicts.set(index, { verdict, note });
  }
  return verdicts;
}

function writeProgress(cwd: string, fingerprint: string, verdicts: ReadonlyMap<number, { verdict: MutantVerdict; note: string }>): void {
  mkdirSync(join(cwd, MUTATION_STATE_DIR), { recursive: true });
  const progress: Progress = {
    version: 1,
    fingerprint,
    verdicts: [...verdicts].sort(([a], [b]) => a - b).map(([index, v]) => ({ index, verdict: v.verdict, note: v.note })),
  };
  writeAtomically(join(cwd, PROGRESS_FILE), `${JSON.stringify(progress)}\n`);
}

function clearProgress(cwd: string): void {
  rmSync(join(cwd, PROGRESS_FILE), { force: true });
}

/**
 * Measure the target project's mutation score.
 *
 * Never throws for an ordinary bad result — a low score, survivors, an empty
 * mutant set, a sample left PARTIAL by its budget are all reported with code
 * 0. It DOES throw when the loop cannot be trusted: an injected suite runner
 * that raises, or a file that does not come back byte-identical after a
 * mutant. Both mean the number would be fiction, and one of them means the
 * user's tree is dirty (its journal stays, for the next gate to act on).
 */
export async function runMutationScore(
  cwd: string,
  options: MutationScoreOptions = {},
): Promise<MutationScoreResult> {
  const minimumSample = options.minimumSample ?? MINIMUM_SAMPLE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runSuite = options.runSuite ?? bunSuiteRunner;
  const now = options.now ?? Date.now;
  const started = now();
  const fits = (): boolean => options.budgetMs === undefined || now() - started + timeoutMs <= options.budgetMs;
  const head: string[] = [];

  const log = (verdict: GuardVerdict, summary: string, detail: Record<string, unknown> = {}): void =>
    logGuardEvent(cwd, { guard: GUARD, verdict, summary, detail });

  const stopped = (code: 1 | 2, summary: string, lines: readonly string[], counts: { sites?: number; sample?: number } = {}): MutationScoreResult => ({
    code,
    lines: [...head, ...lines],
    summary,
    sites: counts.sites ?? 0,
    sample: counts.sample ?? 0,
    complete: false,
    outcomes: [],
    killed: 0,
    survived: 0,
    timedOut: 0,
  });
  const misuse = (summary: string, counts: { sites?: number; sample?: number } = {}): MutationScoreResult => {
    log("error", summary);
    return stopped(2, summary, [`mutation-score: error — ${summary}`], counts);
  };

  // --- preconditions ---
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return misuse(`'${cwd}' is not a directory`);
  if (!existsSync(join(cwd, "package.json"))) return misuse(`no package.json in '${cwd}' — not a project root`);
  // What an earlier, killed run left comes out before anything is read: the
  // sites, the baseline and the fingerprint must all see the user's tree.
  const leftover = restoreLeftoverMutant(cwd);
  if (leftover.status === "refused") return stopped(1, leftover.reason, [`mutation-score: BLOCK — ${leftover.reason}`]);
  if (leftover.status === "restored") head.push(`mutation-score: ${leftover.line}`);
  // Every mutant runs the suite, which loads the project's config as code: it
  // must be what the composed packs generate (ADR 2026-054). Checked before
  // anything else is read, any source mutated or any suite spawned.
  const configBlock = configDriftBlock(GUARD, cwd);
  if (configBlock !== undefined) return stopped(1, configBlock.summary, configBlock.lines);
  let layout: MutableLayout;
  let roots: string[];
  try {
    roots = expandSourceRoots(cwd, sourceRoots(cwd));
    layout = { testSuffixes: testFileSuffixes(cwd), isGenerated: pathGlobMatcher(generatedFileGlobs(cwd)) };
  } catch (error) {
    return misuse(error instanceof Error ? error.message : String(error));
  }
  if (roots.length === 0) return misuse(`no source root in '${cwd}' — nothing to mutate`);

  // --- collect sites ---
  const originals = new Map<string, Buffer>();
  const allSites: MutantSite[] = [];
  const mutatedFiles: string[] = [];
  for (const rel of roots.flatMap((root) => tsFilesUnder(cwd, join(cwd, root)))) {
    const abs = join(cwd, rel);
    const bytes = readFileSync(abs);
    const source = bytes.toString("utf8");
    if (!isMutableSourceFile(rel, source, layout)) continue;
    const found = mutantSites(source, rel);
    if (found.length === 0) continue;
    originals.set(rel, bytes);
    mutatedFiles.push(rel);
    allSites.push(...found);
  }

  if (allSites.length === 0) {
    const summary = "no mutable parse/guard sites under the source roots — nothing to measure";
    log("pass", summary, { sites: 0, sample: 0, mutants: 0, complete: true });
    return { code: 0, lines: [...head, `mutation-score: ${summary}`], summary, sites: 0, sample: 0, complete: true, outcomes: [], killed: 0, survived: 0, timedOut: 0 };
  }

  // --- the sample ---
  const minimum = Math.min(allSites.length, minimumSample);
  if (options.maxMutants !== undefined && options.maxMutants < minimum) {
    const every = minimum === allSites.length ? ` (every site, as there are fewer than ${minimumSample})` : "";
    return misuse(
      `--max-mutants ${options.maxMutants} is below the minimum sample of ${minimum}${every}: a smaller sample makes the score ` +
        "meaningless. Leave it out to take the minimum, or raise it",
      { sites: allSites.length },
    );
  }
  const mutants = selectMutants(allSites, Math.min(allSites.length, options.maxMutants ?? minimumSample));
  const sample = mutants.length;
  const counts = { sites: allSites.length, sample };

  // The green policies, once for the whole measurement: a refusal (no
  // container runtime for a project that needs one) stops it, and a service
  // they prepare backs the baseline and every mutant, never the developer's
  // own database.
  const policy = options.policy ?? (options.runSuite === undefined ? phaseRun(cwd, "green") : NO_POLICY);
  if (policy.refusals.length > 0) {
    const summary = policy.refusals.join("; ");
    log("block", summary, { reason: "test-policy" });
    return stopped(1, summary, policy.refusals.map((r) => `mutation-score: BLOCK — ${r}`), counts);
  }

  // --- progress from earlier calls over this same tree ---
  const fingerprint = sampleFingerprint(cwd, roots, mutants, timeoutMs);
  const saved = readProgress(cwd, fingerprint, sample);
  if (saved === undefined) clearProgress(cwd);
  const verdicts = new Map(saved ?? []);
  const judgedBefore = verdicts.size;

  const classify = "infrastructure" in policy ? policy.infrastructure : undefined;
  type Measured = "budget" | "done" | string | { readonly infrastructure: readonly string[] };
  const measured = await withPreparedServices(policy, async (env): Promise<Measured> => {
    // --- baseline: a score against a red suite is meaningless. Saved
    // progress proves this exact tree was green, so a continuation skips it.
    if (saved === undefined) {
      if (!fits()) return "budget";
      const baseline = await runSuite(cwd, timeoutMs, env, classify);
      if (baseline.infrastructure !== undefined) return { infrastructure: baseline.infrastructure };
      if (!baseline.ok) {
        return `the suite is not green before mutation (${baseline.note}) — ` +
          "every mutant would 'die' for a reason that has nothing to do with it";
      }
      writeProgress(cwd, fingerprint, verdicts);
    }

    // --- the loop: one mutant at a time ---
    let inFlight: { readonly abs: string; readonly site: MutantSite; readonly original: Buffer } | undefined;
    // Ctrl-C or a host's SIGTERM: put the file back before dying of it. Any
    // other listener (the prepared services') runs in the same emit; each
    // removes itself, so the re-raised signal meets the default action.
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      let restored = false;
      if (inFlight !== undefined) {
        try {
          writeFileSync(inFlight.abs, inFlight.original);
          restored = readFileSync(inFlight.abs).equals(inFlight.original);
          if (restored) clearJournal(cwd);
        } catch {
          restored = false;
        }
      }
      const where = inFlight === undefined
        ? "between mutants"
        : `with a mutant in ${inFlight.site.file} (${inFlight.site.label}), ${restored ? "restored" : "NOT restored — the next gate run restores it from the journal"}`;
      log("error", `interrupted by ${signal} ${where}`, {
        kind: "interrupted",
        signal,
        judged: verdicts.size,
        sample,
        ...(inFlight !== undefined ? { file: inFlight.site.file, mutation: inFlight.site.label, restored } : {}),
      });
      process.kill(process.pid, signal);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      for (const [index, site] of mutants.entries()) {
        if (verdicts.has(index)) continue;
        if (!fits()) return "budget";
        const abs = join(cwd, site.file);
        const original = originals.get(site.file)!;
        const text = original.toString("utf8");
        const mutated = Buffer.from(text.slice(0, site.start) + site.replacement + text.slice(site.end));
        writeJournal(cwd, { file: site.file, mutation: site.label, original, mutated });
        inFlight = { abs, site, original };
        writeFileSync(abs, mutated);

        let outcome: SuiteOutcome;
        try {
          outcome = await runSuite(cwd, timeoutMs, env, classify);
        } finally {
          writeFileSync(abs, original);
          // Verify, do not trust: this is the user's repository.
          if (!readFileSync(abs).equals(original)) {
            inFlight = undefined;
            throw new MutationScoreError(
              `mutation-score: failed to restore ${site.file} after a mutant — the target may be left modified`,
            );
          }
          inFlight = undefined;
          clearJournal(cwd);
        }

        // A mutant "killed" by the machine says nothing about the suite.
        if (outcome.infrastructure !== undefined) return { infrastructure: outcome.infrastructure };
        const verdict: MutantVerdict = outcome.timedOut === true ? "timeout" : outcome.ok ? "survived" : "killed";
        verdicts.set(index, { verdict, note: outcome.note });
        writeProgress(cwd, fingerprint, verdicts);
      }
      return "done";
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  });
  if (!measured.ok) {
    log("block", measured.reason, { reason: "test-policy" });
    return stopped(1, measured.reason, [`mutation-score: BLOCK — ${measured.reason}`], counts);
  }
  for (const line of measured.lines) head.push(`mutation-score: ${line}`);
  if (typeof measured.value === "object") {
    const causes = measured.value.infrastructure;
    const summary = "the suite failed because of the machine, not the code";
    log("block", summary, { reason: "infrastructure", causes });
    return stopped(1, summary, [`mutation-score: BLOCK — ${summary}; no mutant was judged`, ...causes.map((c) => `  ${c}`)], counts);
  }
  if (measured.value !== "done" && measured.value !== "budget") {
    clearProgress(cwd);
    return misuse(measured.value, counts);
  }

  // --- report ---
  const outcomes: MutantOutcome[] = [];
  for (const [index, site] of mutants.entries()) {
    const v = verdicts.get(index);
    if (v !== undefined) outcomes.push({ site, verdict: v.verdict, note: v.note });
  }
  const survivors = outcomes.filter((o) => o.verdict === "survived");
  const timedOut = outcomes.filter((o) => o.verdict === "timeout").length;
  const killed = outcomes.length - survivors.length;
  const lines = [...head, ...outcomes.map(reportLine)];
  const base = {
    sites: allSites.length,
    sample,
    outcomes,
    killed,
    survived: survivors.length,
    timedOut,
  };
  const detail = {
    sites: allSites.length,
    sample,
    mutants: outcomes.length,
    killed,
    survived: survivors.length,
    timedOut,
    minimumSample,
    ...(options.maxMutants !== undefined ? { maxMutants: options.maxMutants } : {}),
    timeoutMs,
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
    files: mutatedFiles,
  };

  if (outcomes.length < sample) {
    const summary = `PARTIAL — ${outcomes.length} of ${sampleWords(sample, allSites.length)} judged; no score yet`;
    lines.push("");
    lines.push(
      `mutation-score: ${summary}: this call's time budget (${seconds(options.budgetMs ?? 0)}) has no room for the next ` +
        `mutant's ${seconds(timeoutMs)} timeout.`,
    );
    lines.push(
      "mutation-score: run mutation-score again with the same flags to continue: the verdicts so far are kept while " +
        "the tree is unchanged, and any change starts the sample over.",
    );
    if (outcomes.length === judgedBefore) {
      lines.push(
        `mutation-score: this call judged nothing: its budget is shorter than one suite run's timeout. Give the call a ` +
          "longer timeout, or pass a shorter --timeout-ms.",
      );
    }
    log("pass", summary, { ...detail, complete: false, judgedThisCall: outcomes.length - judgedBefore });
    return { code: 0, lines, summary, complete: false, ...base };
  }

  clearProgress(cwd);
  const score = Math.round((killed / outcomes.length) * 100);
  const timeoutNote = timedOut > 0 ? ` (${timedOut} by timeout)` : "";
  const headline =
    `${sampleWords(sample, allSites.length)} · ${killed} killed${timeoutNote} · ` +
    `${survivors.length} survived · score ${score}%`;

  lines.push("");
  lines.push(`mutation-score: ${headline}`);
  if (survivors.length === 0) {
    lines.push("mutation-score: no survivors — every mutated parse/guard site broke a test.");
  } else {
    lines.push(
      "mutation-score: survivors — each one is a finding: shipped parse/guard logic changed, suite still green.",
    );
    for (const survivor of survivors) {
      lines.push(`mutation-score:   ${survivor.site.file}:${survivor.site.line} ${survivor.site.label}`);
    }
  }
  lines.push("mutation-score: measurement only — no threshold is enforced (TN-26-002).");

  log("pass", headline, {
    ...detail,
    complete: true,
    score,
    survivors: survivors.map((s) => ({
      file: s.site.file,
      line: s.site.line,
      operator: s.site.operator,
      mutation: s.site.label,
    })),
  });

  return { code: 0, lines, summary: headline, complete: true, score, ...base };
}

// --- CLI ------------------------------------------------------------------------

export interface CliArgs {
  readonly targetDir?: string;
  readonly maxMutants?: number;
  readonly timeoutMs?: number;
  /** Set when the argv is unusable; the CLI prints it and exits 2. */
  readonly error?: string;
}

const NUMERIC_FLAGS: Readonly<Record<string, "maxMutants" | "timeoutMs" | undefined>> = {
  "--max-mutants": "maxMutants",
  "--timeout-ms": "timeoutMs",
};

/** `[targetDir] [--max-mutants N] [--timeout-ms N]`, flags in any order. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const out: { targetDir?: string; maxMutants?: number; timeoutMs?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      if (out.targetDir !== undefined) return { error: `unexpected argument '${arg}'` };
      out.targetDir = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const key = NUMERIC_FLAGS[name];
    if (key === undefined) return { error: `unknown option '${name}'` };
    const raw: string | undefined = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    const value = Number(raw);
    if (raw === undefined || !Number.isInteger(value) || value <= 0) {
      return { error: `${name} needs a positive integer (got '${raw ?? ""}')` };
    }
    out[key] = value;
  }
  return out;
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
  const args = parseCliArgs(process.argv.slice(2));
  if (args.error !== undefined) {
    console.error(`mutation-score: error — ${args.error}`);
    console.error("usage: node mutation-score.ts [targetDir] [--max-mutants N] [--timeout-ms N]");
    process.exit(2);
  }
  const cwd = args.targetDir ?? process.cwd();
  runMutationScore(cwd, { maxMutants: args.maxMutants, timeoutMs: args.timeoutMs }).then(
    ({ code, lines }) => {
      for (const line of lines) (code === 0 ? console.log : console.error)(line);
      process.exit(code);
    },
    (e: unknown) => {
      console.error(`mutation-score: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
