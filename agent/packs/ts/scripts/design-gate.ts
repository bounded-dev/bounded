// design gate (issue #13): the DESIGN phase as ONE call with ONE verdict.
//
//   node design-gate.ts [targetDir] [pattern ...]
//
// purity → scaffold → typecheck → design-review → freeze, in that order,
// stopping at the first failure. Every step is the SAME `run*` function the
// individual gates and the CLI already call — this file sequences and reports,
// and reimplements no check. A composite that re-checked anything would be a
// second, drifting implementation of a gate, which is the one thing the gate
// tools exist to avoid.
//
// The design-review step is the one that does not run anything: it reads the
// guard log and refuses to freeze a design no reviewer has CHALLENGED (issue
// #13 §2). The reviewer's findings are advisory — the architect, the trusted
// author of the spec and contracts, weighs them and decides — so this gate
// never judges one. What it enforces is only that a review EXISTS and that it
// covered the current SET of contract files (ADR 2026-020): a review challenges
// the whole design once, so editing a file it already saw does not un-review
// it — only adding or removing a contract file, which is surface the fresh mind
// never read.
//
// It also REPLAYS the findings verbatim. Not judging a finding is not the same
// as not showing it, and the two were conflated: the step printed "fresh (3
// findings, 1 blocker)" and stopped. The reviewer holds `record_design_review`
// and the architect does not, so the count was the only thing about the review
// the architect could ever see — and r15's architect duly went looking for the
// text, tried `git` three times, and finally revived the reviewer to make it
// recite what this gate was already holding. Printing the claims costs nothing
// and settles them one round-trip earlier; judging them is still nobody's job
// here.
//
// Why a composite at all. The four steps were four architect tool calls with a
// mandatory order, and the order lived in prose. Across dogfood runs that cost
// 3–6 minutes per ticket of round-trips, plus the ordering fumbles prose always
// eventually produces: freezing before scaffolding, scaffolding a contract that
// never passed purity, typechecking nothing because the skeletons were not
// generated yet. A sequence with one entry point cannot be run out of order.
//
// The inner runners keep logging their own guard events — "contract-purity",
// "scaffold", "checksum-gate" — because the phase gate derives the DESIGN
// ordering from exactly those names. This gate adds ONE composite event,
// "design-gate", carrying every step's outcome and wall-clock duration.
//
// Exit 0 pass · 1 block · 2 misuse (a step could not run at all). Logs to the
// target's .bounded/guard-log.jsonl.
//
// NOTE: the purity step's globs resolve from the PROCESS cwd (ESLint's own
// default, shared with the `contract_purity` tool) — run this in the project
// directory, which is what both the tool and the CLI do.

import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { runContractPurity } from "./contract-purity.ts";
import { isGeneratedArtifact, runScaffold } from "./scaffold-contract.ts";
import { hasManifest, runChecksumGate } from "./checksum-gate.ts";
import { findingLines, readReviewed, recordedFindings, type Reviewed } from "./design-review.ts";
import type { Finding } from "./sign-off.ts";
import { gateTypecheckOptionsFromEnv, isSkeletonForwardTypeImportDiagnostic } from "./red-gate.ts";
import { formatTypecheck, typecheck } from "./typecheck.ts";
import { diagnosticPath, isDiagnosticStart, projectOwnerOf, routeTypecheck, typecheckLines } from "./typecheck-routing.ts";
import { logGuardEvent, readGuardLog, type GuardVerdict, type LoggedGuardEvent } from "../../../src/guard-log.ts";
import { contractGlobs } from "../../../src/pack-contrib.ts";
import { configDriftBlock } from "./project-config.ts";
import { gateVerdictOf, guardVerdictOf, type GateResult } from "../../../src/gate-result.ts";
import { activeTicketDesign } from "../../../src/ticket-design.ts";

const GUARD = "design-gate";
const REVIEW_GUARD = "design-review";

/** The five steps, in the only order they are legal in. */
export const DESIGN_STEPS = [
  "contract-purity",
  "scaffold",
  "typecheck",
  "design-review",
  "freeze",
] as const;

export type DesignStep = (typeof DESIGN_STEPS)[number];

export interface StepOutcome {
  readonly step: DesignStep;
  readonly code: number;
  /** The step's own output, verbatim from its runner. */
  readonly lines: readonly string[];
  /** Wall clock for this step, milliseconds. */
  readonly ms: number;
}

export interface DesignGateResult extends GateResult {
  /** Only the steps that actually ran: the sequence stops at the first failure. */
  readonly steps: readonly StepOutcome[];
}

/** One decimal second — enough to see which step is costing the round-trip. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * How a step's block reads in the gate's ONE failure line. "blocked" is right
 * for a check that ran and said no; the review step never runs anything, so
 * saying it "blocked" would send the architect looking for output that does
 * not exist. The next line names which of the two it was.
 */
const BLOCK_PHRASE: Partial<Record<DesignStep, string>> = {
  "design-review": "missing (or stale)",
};

/**
 * Turn the steps that ran into the gate's output. Pure: no I/O, no logging.
 *
 * Every design-phase failure routes to the architect. That is not a fallback
 * for want of better attribution — at DESIGN nothing downstream exists yet:
 * there are no tests and no implementation, so no other role could hold a
 * defect even in principle. The typecheck step still PRINTS
 * typecheck-routing's per-owner attribution, because a diagnostic in a
 * generated skeleton points at a different contract defect than one in the
 * contract itself, and that is worth seeing. It just never changes the route.
 */
export function classifyDesignGate(steps: readonly StepOutcome[]): {
  readonly code: 0 | 1 | 2;
  readonly verdict: GuardVerdict;
  readonly summary: string;
  readonly lines: string[];
} {
  const lines: string[] = [];
  for (const s of steps) {
    lines.push(...s.lines, `${s.step}: ${gateVerdictOf(s.code)} (${seconds(s.ms)})`);
  }
  const total = steps.reduce((sum, s) => sum + s.ms, 0);
  const failed = steps.find((s) => s.code !== 0);

  if (failed === undefined) {
    return {
      code: 0,
      verdict: "pass",
      summary: `OK (${DESIGN_STEPS.join(" → ")}, ${seconds(total)})`,
      lines: [...lines, `${GUARD}: OK — ${DESIGN_STEPS.join(" → ")} (${seconds(total)})`],
    };
  }

  // What did NOT run is every step absent from `steps`, in canonical order —
  // not "everything after the failure". On the normal path those are the same
  // list, because the sequence is a prefix. On the re-freeze fast path below
  // the review is evaluated FIRST, so the steps that never ran sit BEFORE the
  // failure as well as after it, and slicing would quietly under-report them.
  const ran = new Set(steps.map((s) => s.step));
  const skipped = DESIGN_STEPS.filter((step) => !ran.has(step));
  const what = failed.code === 1 ? (BLOCK_PHRASE[failed.step] ?? "blocked") : "could not run";
  return {
    code: failed.code === 1 ? 1 : 2,
    verdict: guardVerdictOf(failed.code),
    summary: `${failed.step} ${what} (route: architect)`,
    lines: [
      ...lines,
      `${GUARD}: FAIL — ${failed.step} ${what}` +
        (skipped.length > 0 ? `; ${skipped.join(", ")} did not run` : ""),
      `${GUARD}: route → architect`,
    ],
  };
}

/** What the typecheck step allowed through on a re-freeze: worker-owned drift
 *  the change itself created, recorded so the composite event says so. */
export interface TypecheckDrift {
  readonly errors: number;
  readonly owners: readonly string[];
}

/**
 * The project typecheck, run exactly as the red and green gates run it — same
 * runner, same env seam, same routing renderer.
 *
 * ON A RE-FREEZE, WORKER-OWNED DRIFT DOES NOT BLOCK (ADR 2026-028). A change
 * run revises the contract over a tree that already implements the old one, so
 * the tree failing to compile IS the change: the existing implementation and
 * tests no longer match the revised design, and repairing them is exactly what
 * the two workers are commissioned to do — which they cannot be until the
 * freeze this step was blocking. So diagnostics owned entirely by the workers
 * are printed, attributed and let through; nothing is hidden, and green_gate
 * still requires a fully compiling project, so the false-green invariant
 * (ADR 2026-017) is untouched.
 *
 * What still blocks a re-freeze: a diagnostic in design-owned surface — a
 * contract file, project config (`orchestrator`), or a GENERATED skeleton,
 * whose errors are the contract's own defects wearing the builder's path. A
 * FIRST freeze keeps the full block: there, `src/` holds nothing but skeletons
 * and no tests exist yet, so every diagnostic is the design's.
 */
async function runProjectTypecheck(
  cwd: string,
  reFreeze: boolean,
): Promise<{ code: number; lines: readonly string[]; drift?: TypecheckDrift }> {
  const result = await typecheck(cwd, gateTypecheckOptionsFromEnv());
  if (result.ok) return { code: 0, lines: [formatTypecheck(result)] };
  // The service skill's router type is a type-only import of a value only the
  // builder writes, so no first design could freeze without this (dogfood).
  if (result.diagnostics.length > 0 && result.diagnostics.every((line) => isSkeletonForwardTypeImportDiagnostic(cwd, line))) {
    const n = result.diagnostics.length;
    return {
      code: 0,
      lines: [
        `typecheck: OK — ${n} forward type import${n === 1 ? "" : "s"} of a value the builder adds to a generated skeleton`,
        ...result.diagnostics.map((l) => `  ${l}`),
        "  the red gate's shadow and the green gate's clean typecheck still require the builder to export it",
      ],
    };
  }

  const routing = routeTypecheck(result.diagnostics, projectOwnerOf(cwd));
  if (routing.errorCount === 0) {
    // tsc failed without emitting a parseable diagnostic — a broken tsconfig, a
    // crash, a missing toolchain. That is misuse (the gate could not run), not
    // a design defect, and claiming "0 type errors" would be a lie.
    return {
      code: 2,
      lines: [
        "typecheck: ERROR — tsc failed without a parseable diagnostic",
        ...result.diagnostics.map((l) => `  ${l}`),
      ],
    };
  }
  const plural = routing.errorCount === 1 ? "" : "s";

  if (reFreeze) {
    const generated = (routing.byOwner.builder ?? [])
      .filter(isDiagnosticStart)
      .map((l) => diagnosticPath(l))
      .filter((p): p is string => p !== undefined)
      .filter((p) => {
        try {
          return isGeneratedArtifact(readFileSync(join(cwd, p), "utf8"));
        } catch {
          return false; // a diagnostic naming a file that is not on disk is not a skeleton's
        }
      });
    const designOwned = routing.owners.some((o) => o === "architect" || o === "orchestrator");
    if (!designOwned && generated.length === 0) {
      return {
        code: 0,
        lines: [
          `typecheck: ${routing.errorCount} pre-freeze drift error${plural} — all worker-owned, so the re-freeze proceeds`,
          ...typecheckLines(routing).slice(1),
          "  this drift is the change itself: the workers repair their own zones once commissioned, and green_gate still requires a clean project",
        ],
        drift: { errors: routing.errorCount, owners: [...routing.owners] },
      };
    }
    if (generated.length > 0) {
      return {
        code: 1,
        lines: [
          `typecheck: ${routing.errorCount} type error${plural}`,
          ...typecheckLines(routing).slice(1),
          `  note: ${[...new Set(generated)].join(", ")} ${generated.length === 1 ? "is a" : "are"} generated skeleton${generated.length === 1 ? "" : "s"} — those diagnostics are the contract's own, not builder drift`,
        ],
      };
    }
  }

  return {
    code: 1,
    // typecheckLines' first line is its own count headline; the rest is the
    // per-owner attribution, reused verbatim rather than re-rendered here.
    lines: [`typecheck: ${routing.errorCount} type error${plural}`, ...typecheckLines(routing).slice(1)],
  };
}

// --- the design-review step -----------------------------------------------------

/**
 * Whether the recorded review covers the current design, by FILE SET.
 *
 * `fresh` — the latest review covered the same set of files the design now has,
 * so the whole design has been challenged. It carries the counts AND the
 * findings themselves: the counts are what the gate reasons about (nothing here
 * judges a finding — that is the architect's call, and a gate that could judge
 * one would not need a reviewer); the findings are what it hands on, because the
 * architect cannot reach them any other way.
 *
 * `stale` — a contract file was ADDED or REMOVED since the review, so the design
 * has surface the fresh mind never saw. A file whose CONTENT changed but whose
 * path the review already covered is NOT stale: the architect owns the spec and
 * the contracts and may revise them in answer to what the review raised.
 */
export type ReviewFreshness =
  | {
      readonly state: "fresh";
      readonly at: string;
      readonly findings: number;
      readonly blockers: number;
      /** The claims themselves, as the reviewer recorded them. */
      readonly recorded: readonly Finding[];
    }
  | { readonly state: "missing" }
  | {
      readonly state: "stale";
      readonly at: string;
      readonly added: readonly string[];
      readonly removed: readonly string[];
    }
  /** The design cannot be reviewed at all (no spec.md), so it cannot be fresh. */
  | { readonly state: "unreviewable"; readonly reason: string };

/** The `detail.reviewed` map of a recorded review, or undefined if it carries none. */
function reviewedFiles(event: LoggedGuardEvent): Reviewed | undefined {
  const raw = (event.detail as { reviewed?: unknown } | undefined)?.reviewed;
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, string> = {};
  for (const [file, hash] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof hash !== "string") return undefined;
    out[file] = hash;
  }
  return out;
}

/**
 * What the review said: the counts the gate reasons about, and the claims it
 * replays. A malformed detail counts zero and replays nothing — an older event
 * that recorded only severities still yields its counts, which is why the
 * counts are not simply `recorded.length`.
 */
function reviewCounts(event: LoggedGuardEvent): {
  findings: number;
  blockers: number;
  recorded: Finding[];
} {
  const detail = event.detail as
    | { findings?: unknown; severities?: unknown; blockers?: unknown }
    | undefined;
  const severities = Array.isArray(detail?.severities) ? detail.severities : [];
  return {
    findings: Array.isArray(detail?.findings) ? detail.findings.length : severities.length,
    blockers:
      typeof detail?.blockers === "number"
        ? detail.blockers
        : severities.filter((s) => s === "blocker").length,
    recorded: recordedFindings(event.detail),
  };
}

/**
 * Does a recorded review cover the current design, by file set? Pure: no I/O.
 *
 * THE LATEST PASS BY APPEND ORDER is the review that stands — the same rule
 * green-gate uses for the red it requires, and for the same reason: "the last
 * thing the log says" is one event to find and cannot depend on how long the
 * log is.
 *
 * The comparison is over PATHS, not bytes. The design is challenged as a whole,
 * once: a file the review already covered is a file the fresh mind read, and an
 * edit the architect made to it in answer to the review does not un-read it.
 * What the review never saw is a contract file added since (new surface) or the
 * hole left by one removed (the shape it read is gone), so only add/remove
 * stales it. The recorded hashes are ignored here; they stay in the log as
 * provenance (ADR 2026-020, amending 2026-020's original byte lock).
 *
 * `verdict: "error"` events are misuse — no spec, no contracts, a malformed
 * payload — and are not reviews. So is a pass carrying no file record: it
 * demonstrably covers nothing.
 */
export function classifyReviewFreshness(
  events: readonly LoggedGuardEvent[],
  current: Reviewed,
  ticket?: string,
): ReviewFreshness {
  let latest: LoggedGuardEvent | undefined;
  for (const e of events) {
    if (e.guard === REVIEW_GUARD && e.verdict === "pass" &&
      (e.detail as { ticket?: unknown } | undefined)?.ticket === ticket) latest = e;
  }
  if (latest === undefined) return { state: "missing" };

  const reviewed = reviewedFiles(latest);
  if (reviewed === undefined) return { state: "missing" };

  const reviewedSet = new Set(Object.keys(reviewed));
  const added = Object.keys(current).filter((f) => !reviewedSet.has(f)).sort();
  const removed = [...reviewedSet].filter((f) => !(f in current)).sort();
  if (added.length > 0 || removed.length > 0) {
    return { state: "stale", at: latest.ts, added, removed };
  }
  return { state: "fresh", at: latest.ts, ...reviewCounts(latest) };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Render the freshness verdict as the step's output. Pure: no I/O. */
export function reviewStepOutcome(freshness: ReviewFreshness): {
  code: 0 | 1;
  lines: string[];
} {
  const commission =
    "  Commission the `reviewer` subagent once on the design note and owned contracts; it";
  switch (freshness.state) {
    case "fresh":
      return {
        code: 0,
        // A PASSING step still prints why it passed, and REPLAYS the findings
        // verbatim: you hold no `record_design_review`, so this is the only
        // place the reviewer's words reach you. Every finding, blockers
        // included, is a challenge for you to weigh — the freeze does not wait
        // on any of them, and you may freeze over them.
        lines: [
          `design-review: challenged (${count(freshness.findings, "finding")}, ` +
            `${count(freshness.blockers, "blocker")}) — advisory; you decide.`,
          ...findingLines(freshness.recorded),
        ],
      };
    case "missing":
      return {
        code: 1,
        lines: [
          "design-review: BLOCK — this design has not been challenged",
          "  Commission the `reviewer` once on the current contracts, weigh what it",
          "  raises, then freeze.",
        ],
      };
    case "stale": {
      const moved = [...freshness.added, ...freshness.removed].join(", ");
      return {
        code: 1,
        lines: [
          `design-review: BLOCK — the reviewer never saw ${moved} — a contract file changed the design's shape since the review; commission it once more.`,
          ...(freshness.added.length > 0 ? [`  added since the review: ${freshness.added.join(", ")}`] : []),
          ...(freshness.removed.length > 0 ? [`  removed since the review: ${freshness.removed.join(", ")}`] : []),
        ],
      };
    }
    case "unreviewable":
      return {
        code: 1,
        lines: [`design-review: BLOCK — ${freshness.reason}`, commission, "  records what it found."],
      };
  }
}

/**
 * The freshness check, with its one I/O step: read the design's current file
 * set and the guard log, then classify.
 */
function runDesignReviewStep(cwd: string): {
  code: number;
  lines: readonly string[];
  freshness: ReviewFreshness;
} {
  const ticket = activeTicketDesign(cwd);
  if (ticket?.status === "draft") {
    const freshness: ReviewFreshness = { state: "unreviewable", reason: `${ticket.note} is draft; mark the agreed design active before freezing` };
    return { ...reviewStepOutcome(freshness), freshness };
  }
  const design = readReviewed(cwd);
  const freshness: ReviewFreshness = design.ok
    ? classifyReviewFreshness(readGuardLog(cwd), design.reviewed, ticket?.ticket)
    : { state: "unreviewable", reason: design.error };
  return { ...reviewStepOutcome(freshness), freshness };
}

/**
 * The one line an early-blocked re-freeze prints before the review's own
 * output, so the transcript says why design-review is speaking out of turn.
 */
const EARLY_NOTICE =
  `${GUARD}: already frozen, so design-review is checked FIRST — a stale review blocks before anything is re-run`;

/** Classify, log the composite event, return. Shared by both entry paths so a
 *  fast-path block is reported and recorded exactly like any other. */
function finishDesignGate(
  cwd: string,
  steps: readonly StepOutcome[],
  review: ReviewFreshness | undefined,
  extra: Readonly<Record<string, unknown>>,
): DesignGateResult {
  const verdict = classifyDesignGate(steps);
  const failed = steps.find((s) => s.code !== 0);
  const frozenDesign = failed === undefined ? readReviewed(cwd) : undefined;
  const detail = {
    steps: steps.map((s) => ({
      step: s.step,
      code: s.code,
      verdict: guardVerdictOf(s.code),
      ms: s.ms,
    })),
    ms: steps.reduce((sum, s) => sum + s.ms, 0),
    ...(review !== undefined ? { review } : {}),
    ...(failed !== undefined ? { failed: failed.step, route: "architect" } : {}),
    ...(frozenDesign?.ok ? { frozenDesign: frozenDesign.reviewed } : {}),
    ticket: activeTicketDesign(cwd)?.ticket,
    ownedPaths: activeTicketDesign(cwd) ? [activeTicketDesign(cwd)!.note, ...activeTicketDesign(cwd)!.contracts] : undefined,
    ...extra,
  };
  logGuardEvent(cwd, { guard: GUARD, verdict: verdict.verdict, summary: verdict.summary, detail });
  return { ...verdict, steps: [...steps], detail };
}

/**
 * Run the whole DESIGN phase and return one verdict.
 *
 * The architect reaches this through the `design_gate` tool and the CLI below
 * reaches it here, so the gate cannot differ by how it was invoked.
 *
 * ORDER, AND THE ONE EXCEPTION. The five steps have exactly one legal order and
 * the sequence below is it. But on a RE-FREEZE — a project that already has a
 * checksum manifest, so this design has been through the gate before — the
 * review-freshness step is evaluated first, as a pre-flight, and a stale or
 * missing review blocks there.
 *
 * That is sound because freshness is the one step whose answer does not depend
 * on any other: it compares the guard log against the CURRENT set of contract
 * files, and neither purity nor scaffolding nor tsc adds or removes those.
 * (Scaffolding writes skeletons and law suites, which no review covers.) It is
 * worth doing because run r14 paid a full purity + scaffold + typecheck pass,
 * repeatedly, only to be told at step four to go and commission the reviewer.
 *
 * It applies only to a re-freeze. A FIRST run has no earlier review to be stale
 * against, so the fast path could only ever report "never reviewed" — which is
 * the normal state of a design being frozen for the first time — and it would
 * report it before scaffolding, which is what has to happen before anything can
 * typecheck at all.
 *
 * HOW THE TWO CASES READ. An early block prints EARLY_NOTICE, then the review's
 * own lines, then the one FAIL line naming the four steps that did not run: the
 * out-of-turn position is stated rather than left to be inferred. An early PASS
 * is SILENT — the pre-flight prints nothing and the step runs again in its own
 * position, where its `design-review: fresh (…)` line appears between typecheck
 * and freeze exactly as it always has. The second evaluation costs one guard-log
 * read and keeps the passing narrative in the canonical order, which is the half
 * of the transcript anyone reads twice.
 */
export async function runDesignGate(
  cwd: string,
  patterns?: readonly string[],
): Promise<DesignGateResult> {
  // Set by the design-review step below, so the composite event can record what
  // the review said as well as that it ran.
  let review: ReviewFreshness | undefined;
  // Set by the typecheck step when a re-freeze let worker-owned drift through,
  // so the composite event records that the freeze knowingly stood over it.
  let drift: TypecheckDrift | undefined;

  // Project config the composed packs did not generate is refused before any
  // step runs: the typecheck step loads it (ADR 2026-054).
  const configBlock = configDriftBlock(GUARD, cwd);
  if (configBlock !== undefined) return { ...configBlock, steps: [] };

  const reFreeze = hasManifest(cwd);
  if (reFreeze) {
    const started = Date.now();
    const early = runDesignReviewStep(cwd);
    if (early.code !== 0) {
      return finishDesignGate(
        cwd,
        [
          {
            step: "design-review",
            code: early.code,
            lines: [EARLY_NOTICE, ...early.lines],
            ms: Date.now() - started,
          },
        ],
        early.freshness,
        { reFreeze: true, checkedFirst: "design-review" },
      );
    }
  }
  const sequence: readonly {
    readonly step: DesignStep;
    readonly run: () => Promise<{ code: number; lines: readonly string[] }>;
  }[] = [
    { step: "contract-purity", run: () => runContractPurity(cwd, patterns) },
    { step: "scaffold", run: async () => runScaffold(cwd) },
    {
      step: "typecheck",
      run: async () => {
        const r = await runProjectTypecheck(cwd, reFreeze);
        drift = r.drift;
        return { code: r.code, lines: r.lines };
      },
    },
    // Reviewed BEFORE the freeze, because after it the review is worth a
    // fraction of what it cost: run r13 measured 30–38 minutes to repair a
    // contract defect discovered once the test-writer was already building on
    // it. The step reads the log and runs nothing, so it is also the cheapest
    // in the sequence — it just has to sit where a failure is still free.
    {
      step: "design-review",
      run: async () => {
        const r = runDesignReviewStep(cwd);
        review = r.freshness;
        return { code: r.code, lines: r.lines };
      },
    },
    // Freezing LAST is the whole point of the order: the manifest must record
    // the contract that passed every check, not the one that was written.
    { step: "freeze", run: async () => runChecksumGate(cwd, true) },
  ];

  const steps: StepOutcome[] = [];
  for (const { step, run } of sequence) {
    const started = Date.now();
    const r = await run();
    steps.push({ step, code: r.code, lines: [...r.lines], ms: Date.now() - started });
    if (r.code !== 0) break; // stop at the first failure — nothing downstream is meaningful
  }

  return finishDesignGate(cwd, steps, review, {
    reFreeze,
    ...(drift !== undefined ? { typecheckDrift: drift } : {}),
  });
}

// --- CLI ------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const patterns = argv.slice(1);
  const result = await runDesignGate(argv[0] ?? process.cwd(), patterns.length > 0 ? patterns : undefined);
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
      console.error(`design-gate: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
