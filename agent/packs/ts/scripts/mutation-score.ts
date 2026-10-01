// Mutation score (TN-26-002, "Mutation matrix"): how much of the delivered
// logic does the suite actually hold down?
//
//   node mutation-score.ts [targetDir] [--max-mutants N] [--timeout-ms N]
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
// --- selection (deterministic, so runs are comparable) --------------------------
//
// Sites are collected in (file path, source offset) order, then dealt out
// ROUND-ROBIN across files until `--max-mutants` (default 40) is reached. A
// project's first file cannot eat the whole budget, and two runs over the same
// tree always pick the same mutants in the same order. The cap exists because
// each mutant costs one full suite run; 40 × a delivered project's suite is
// the most a per-run measurement can afford.
//
// --- the loop -------------------------------------------------------------------
//
// One mutant at a time: splice the replacement into the file at the AST's
// offsets, run the suite through the run-tests seam, restore the file from the
// bytes read before the edit, and VERIFY the restore by comparing buffers —
// the target is the user's repo, and "we wrote it back" is not evidence. The
// restore is in a `finally`, so it happens even when the suite runner throws;
// a runner that throws aborts the whole measurement rather than being scored,
// because a broken runner is a broken environment, not a property of the
// mutant. A restore that does not verify is fatal for the same reason.
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

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { generatedFileGlobs, hasTestFileSuffix, pathGlobMatcher, sourceRoots, testFileSuffixes } from "../../../src/pack-contrib.ts";
import { expandSourceRoots } from "../../../src/path-gate.ts";
import { phaseRun } from "./phase-policy.ts";
import { fileURLToPath } from "node:url";
import { Node, Project, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { logGuardEvent, type GuardVerdict } from "../../../src/guard-log.ts";
import { runTests, spawnRunner } from "./run-tests.ts";
import { configDriftBlock } from "./project-config.ts";

const GUARD = "mutation-score";

/** Default cap on mutants per run. Each one costs a full suite run. */
export const DEFAULT_MAX_MUTANTS = 40;
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
 * Deal `sites` out round-robin across files until `max` is reached.
 *
 * Input must already be in (file, offset) order; output keeps each file's
 * sites in that order. Deterministic, so two runs over the same tree choose
 * the same mutants — that is the whole point of a standing measurement.
 */
export function selectMutants(sites: readonly MutantSite[], max: number): MutantSite[] {
  if (max <= 0) return [];
  const byFile = new Map<string, MutantSite[]>();
  for (const site of sites) {
    const bucket = byFile.get(site.file);
    if (bucket === undefined) byFile.set(site.file, [site]);
    else bucket.push(site);
  }
  const buckets = [...byFile.values()];
  const picked: MutantSite[] = [];
  for (let round = 0; picked.length < max; round++) {
    let dealt = false;
    for (const bucket of buckets) {
      const site: MutantSite | undefined = bucket[round];
      if (site === undefined) continue;
      picked.push(site);
      dealt = true;
      if (picked.length === max) return picked;
    }
    if (!dealt) break;
  }
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
}

/** Runs the target's suite once. Injectable so tests never spawn bun. */
export type SuiteRunner = (cwd: string, timeoutMs: number) => Promise<SuiteOutcome>;

/** The real runner: run_tests' bun runner, bounded by an AbortSignal, with
 *  the environment the phase test policies give a green run. */
export const bunSuiteRunner: SuiteRunner = async (cwd, timeoutMs) => {
  const signal = AbortSignal.timeout(timeoutMs);
  const policy = phaseRun(cwd, "green");
  if (policy.refusals.length > 0) return { ok: false, note: policy.refusals.join("; ") };
  try {
    const result = await runTests(cwd, {
      env: policy.env,
      run: (command, args, dir, _signal, env) => spawnRunner(command, args, dir, signal, env),
    });
    if (result.blocked !== undefined) return { ok: false, note: "suite blocked" };
    return { ok: result.ok, note: result.ok ? "green" : `${result.failed} failed` };
  } catch (e) {
    if (signal.aborted) return { ok: false, timedOut: true, note: `timeout after ${timeoutMs}ms` };
    throw e;
  }
};

// --- runner ---------------------------------------------------------------------

export type MutantVerdict = "killed" | "survived" | "timeout";

export interface MutantOutcome {
  readonly site: MutantSite;
  readonly verdict: MutantVerdict;
  readonly note: string;
}

export interface MutationScoreOptions {
  /** Cap on mutants run. Default {@link DEFAULT_MAX_MUTANTS}. */
  readonly maxMutants?: number;
  /** Per-mutant suite timeout in ms. Default {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Suite runner. Default {@link bunSuiteRunner}. */
  readonly runSuite?: SuiteRunner;
}

export interface MutationScoreResult {
  /** 0 whenever the measurement ran (whatever the score); 2 for misuse. */
  readonly code: number;
  readonly lines: readonly string[];
  /** Total mutable sites found, before the cap. */
  readonly sites: number;
  readonly outcomes: readonly MutantOutcome[];
  readonly killed: number;
  readonly survived: number;
  readonly timedOut: number;
  /** killed ÷ mutants as a whole-number percentage; undefined when no mutants. */
  readonly score?: number;
}

/** Verdict prefix, padded so the report reads as a column. */
const PREFIX_WIDTH = 8;

function reportLine(outcome: MutantOutcome): string {
  const verdict = outcome.verdict.toUpperCase().padEnd(PREFIX_WIDTH);
  const suffix = outcome.verdict === "timeout" ? " (counted as killed)" : "";
  return `${verdict} ${outcome.site.file}:${outcome.site.line} ${outcome.site.label}${suffix}`;
}

/**
 * Measure the target project's mutation score.
 *
 * Never throws for an ordinary bad result — a low score, survivors, an empty
 * mutant set are all reported with code 0. It DOES throw when the loop cannot
 * be trusted: an injected suite runner that raises, or a file that does not
 * come back byte-identical after a mutant. Both mean the number would be
 * fiction, and one of them means the user's tree is dirty.
 */
export async function runMutationScore(
  cwd: string,
  options: MutationScoreOptions = {},
): Promise<MutationScoreResult> {
  const maxMutants = options.maxMutants ?? DEFAULT_MAX_MUTANTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runSuite = options.runSuite ?? bunSuiteRunner;
  const lines: string[] = [];

  const log = (verdict: GuardVerdict, summary: string, detail: Record<string, unknown> = {}): void =>
    logGuardEvent(cwd, { guard: GUARD, verdict, summary, detail });

  const misuse = (summary: string): MutationScoreResult => {
    log("error", summary);
    return {
      code: 2,
      lines: [...lines, `mutation-score: error — ${summary}`],
      sites: 0,
      outcomes: [],
      killed: 0,
      survived: 0,
      timedOut: 0,
    };
  };

  // --- preconditions ---
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return misuse(`'${cwd}' is not a directory`);
  if (!existsSync(join(cwd, "package.json"))) return misuse(`no package.json in '${cwd}' — not a project root`);
  // Every mutant runs the suite, which loads the project's config as code: it
  // must be what the composed packs generate (ADR 2026-054). Checked before
  // anything else is read, any source mutated or any suite spawned.
  const configBlock = configDriftBlock(GUARD, cwd);
  if (configBlock !== undefined) {
    return { code: 1, lines: [...lines, ...configBlock.lines], sites: 0, outcomes: [], killed: 0, survived: 0, timedOut: 0 };
  }
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

  const mutants = selectMutants(allSites, maxMutants);
  if (mutants.length === 0) {
    const summary =
      allSites.length === 0
        ? "no mutable parse/guard sites under the source roots — nothing to measure"
        : `--max-mutants ${maxMutants} selected no mutants`;
    lines.push(`mutation-score: ${summary}`);
    log("pass", summary, { sites: allSites.length, mutants: 0, maxMutants });
    return { code: 0, lines, sites: allSites.length, outcomes: [], killed: 0, survived: 0, timedOut: 0 };
  }

  // --- baseline: a score against a red suite is meaningless ---
  const baseline = await runSuite(cwd, timeoutMs);
  if (!baseline.ok) {
    return misuse(
      `the suite is not green before mutation (${baseline.note}) — ` +
        "every mutant would 'die' for a reason that has nothing to do with it",
    );
  }

  // --- the loop: one mutant at a time ---
  const outcomes: MutantOutcome[] = [];
  for (const site of mutants) {
    const abs = join(cwd, site.file);
    const original = originals.get(site.file)!;
    const text = original.toString("utf8");
    writeFileSync(abs, text.slice(0, site.start) + site.replacement + text.slice(site.end));

    let outcome: SuiteOutcome;
    try {
      outcome = await runSuite(cwd, timeoutMs);
    } finally {
      writeFileSync(abs, original);
      // Verify, do not trust: this is the user's repository.
      if (!readFileSync(abs).equals(original)) {
        throw new MutationScoreError(
          `mutation-score: failed to restore ${site.file} after a mutant — the target may be left modified`,
        );
      }
    }

    const verdict: MutantVerdict = outcome.timedOut === true ? "timeout" : outcome.ok ? "survived" : "killed";
    const record = { site, verdict, note: outcome.note };
    outcomes.push(record);
    lines.push(reportLine(record));
  }

  // --- report ---
  const survivors = outcomes.filter((o) => o.verdict === "survived");
  const timedOut = outcomes.filter((o) => o.verdict === "timeout").length;
  const killed = outcomes.length - survivors.length;
  const score = Math.round((killed / outcomes.length) * 100);

  const capped = allSites.length > outcomes.length ? ` of ${allSites.length} sites` : "";
  const timeoutNote = timedOut > 0 ? ` (${timedOut} by timeout)` : "";
  const headline =
    `${outcomes.length} mutants${capped} · ${killed} killed${timeoutNote} · ` +
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
    sites: allSites.length,
    mutants: outcomes.length,
    killed,
    survived: survivors.length,
    timedOut,
    score,
    maxMutants,
    timeoutMs,
    files: mutatedFiles,
    survivors: survivors.map((s) => ({
      file: s.site.file,
      line: s.site.line,
      operator: s.site.operator,
      mutation: s.site.label,
    })),
  });

  return {
    code: 0,
    lines,
    sites: allSites.length,
    outcomes,
    killed,
    survived: survivors.length,
    timedOut,
    score,
  };
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
