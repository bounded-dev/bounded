// design-review (issue #13 §2): the reviewer's pen.
//
//   node design-review.ts [targetDir] '<findings json>'
//
// THE DESIGN PHASE HAD NO REVIEW STEP. The architect wrote a spec and a
// contract, and the only quality check on either was "commission the
// test-writer and see what explodes". Live run r13 measured the bill: a
// contract frozen as four files, ~38 minutes lost mid-loop to collapsing it to
// one, and the discovery arrived as 129 type errors when the test-writer's
// output met the frozen contract. Every one of those errors was legible in the
// contract before a single test existed — nobody was asked to look.
//
// So somebody is asked to look, before the freeze. The reviewer reads the spec
// and every contract as the two blind consumers will, and records what it found
// here. Like sign-off, THIS GATE RECORDS A CLAIM AND NEVER JUDGES ONE: whether
// a finding is real is the architect's call, and a gate that could decide it
// would not need the reviewer. What the gate guarantees is that the answer
// EXISTS, in a greppable line, including the answer "I found nothing" — a
// silence and a clean review are indistinguishable unless one of them is
// written down.
//
// The record names the FILE SET it covered. A review challenges the whole
// design once; the architect, who owns the spec and the contracts, then revises
// them in answer to what it raised — which is the point of hearing it, and does
// not un-review the design. So an edit to a file the review already saw is not
// what stales it; only a contract file added or removed since is (ADR LEG-2026-020).
// The event still carries a sha256 per file — computed exactly as checksum-gate
// computes them — as provenance in the log; the freshness decision reads only
// the keys.
//
// THE FINDINGS TRAVEL WITH THE RECORD. r15's architect commissioned a review,
// got a count back, and could not read what the reviewer had actually said: it
// tried `git` three times looking for the text, then revived the reviewer as a
// subagent purely to make it recite findings this tool had already stored. So
// every rendering of a review — this tool's own result, and the design_gate
// step that reads the record back out of the log — prints each finding
// verbatim: severity, summary, and evidence. A count is an index into a
// document nobody can open.
//
// Exit 0 recorded · 2 misuse (no spec.md, no contracts, malformed findings).
// There is no exit 1: findings are not a failure, they are the deliverable.

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logGuardEvent } from "../../../src/guard-log.ts";
import type { GateResult } from "../../../src/gate-result.ts";
import { computeManifest, hashContract } from "./checksum-gate.ts";
import { parseFindings, type Finding } from "./sign-off.ts";
import { activeTicketDesign, designNotePath } from "../../../src/ticket-design.ts";

const GUARD = "design-review";

/**
 * The polish-loop nudge (r15/r16). The k3 architect ran 4-5 review cycles AFTER
 * already getting zero blockers, polishing advisory findings the freeze does
 * not wait on. Reviews are advisory and this changes no verdict — it only makes
 * the freezable-now fact loud where the architect reads it, so an optional
 * round of polish is not mistaken for a required one. One spelling, exported so
 * design-review's own result and design-gate's fresh-review line cannot drift.
 */
export const FREEZABLE_NOW =
  "design-review: 0 blockers: this design is freezable now; further review cycles are optional polish, not required.";

/** How much of a sha256 is worth printing to a human. Full hashes go in the log. */
const SHORT_HASH = 12;

/** The shared contract, with `code` narrowed: a review is recorded (0) or the
 *  call was misuse (2) — the gate never judges the findings, so it never blocks. */
export type DesignReviewResult = GateResult & { readonly code: 0 | 2 };

/**
 * The exact bytes reviewed: project-relative posix path → sha256, `spec.md`
 * first, then every contract in checksum-gate's order.
 *
 * Hashing is checksum-gate's `hashContract` (newline-normalized sha256) and
 * contract discovery is its `computeManifest`, so "the contract the reviewer
 * read" and "the contract the freeze recorded" are the same question asked
 * twice, never two implementations that can disagree.
 */
export type Reviewed = Readonly<Record<string, string>>;

/** Read and hash the design under review. The one I/O step. */
export function readReviewed(cwd: string): { ok: true; reviewed: Reviewed } | { ok: false; reason: string; error: string } {
  const note = designNotePath(cwd);
  const specPath = join(cwd, note);
  if (!existsSync(specPath)) {
    return {
      ok: false,
      reason: "no-spec",
      error:
        `no ${note} to review — write the design note before commissioning the review`,
    };
  }

  // Composition determines which project rules and delivery obligations are
  // active. Review freshness is based on design surface, so use one identity
  // key per selected pack: adding or removing a pack stales the review, while
  // edits to ordinary reviewed prose remain fresh. Read first: the contracts
  // themselves are found through the composition's source roots.
  const composition = join(cwd, ".bounded/composed-packs.json");
  const packKeys: string[] = [];
  if (existsSync(composition)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(composition, "utf8")) as unknown;
    } catch {
      return { ok: false, reason: "invalid-composition", error: "project composition is malformed and cannot be reviewed" };
    }
    if (!Array.isArray(raw) || raw.some((pack) => typeof pack !== "string")) {
      return { ok: false, reason: "invalid-composition", error: "project composition is malformed and cannot be reviewed" };
    }
    for (const pack of [...raw].sort()) packKeys.push(pack);
  }

  let contracts: Readonly<Record<string, string>>;
  try {
    contracts = computeManifest(cwd).files;
  } catch (error) {
    return { ok: false, reason: "invalid-composition", error: `the design's contracts cannot be found: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (Object.keys(contracts).length === 0) {
    return {
      ok: false,
      reason: "no-contracts",
      error:
        "no *.contract.ts files to review — the contract is the typed half of what the two blind roles build against, and a review of half a design is not a review",
    };
  }

  const reviewed: Record<string, string> = {
    [note]: hashContract(readFileSync(specPath, "utf8")),
  };
  for (const [file, hash] of Object.entries(contracts)) reviewed[file] = hash;
  const context = join(cwd, "CONTEXT.md");
  if (existsSync(context)) reviewed["CONTEXT.md"] = hashContract(readFileSync(context, "utf8"));
  const adrs = join(cwd, "ADRs");
  if (existsSync(adrs)) {
    for (const entry of readdirSync(adrs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const path = `ADRs/${entry.name}`;
        reviewed[path] = hashContract(readFileSync(join(adrs, entry.name), "utf8"));
      }
    }
  }
  const baseline = join(cwd, ".bounded/change-baseline.json");
  if (existsSync(baseline)) reviewed[".bounded/change-baseline.json"] = hashContract(readFileSync(baseline, "utf8"));
  for (const pack of packKeys) reviewed[`composition:${pack}`] = hashContract(pack);
  return { ok: true, reviewed };
}

/**
 * One indented line per finding: severity, summary, evidence. The ONE
 * rendering, used by this gate's own output and by the `design_gate` step that
 * replays a recorded review out of the guard log — two spellings of a finding
 * would be two answers to "what did the reviewer say".
 */
export function findingLines(findings: readonly Finding[]): string[] {
  return findings.map(
    (f) => `  ${f.severity}: ${f.summary}${f.evidence === undefined ? "" : ` — ${f.evidence}`}`,
  );
}

/**
 * The findings a logged `design-review` event carries, or `[]` when its detail
 * holds none in a readable shape.
 *
 * The log is written by this module and read back by design-gate, but it is
 * still a FILE: hand-edited, truncated mid-write, or written by an older
 * version that stored only counts. Anything that does not parse as a finding
 * yields the empty list rather than a throw, exactly as `readGuardLog` skips a
 * corrupt line — a review whose text cannot be recovered still happened, and
 * the freshness check does not depend on the text.
 */
export function recordedFindings(detail: unknown): Finding[] {
  const raw = (detail as { findings?: unknown } | undefined)?.findings;
  if (!Array.isArray(raw)) return [];
  const parsed = parseFindings(raw);
  return parsed.ok ? parsed.findings : [];
}

/** Format the record. Pure: no I/O, no logging, no judgement of a finding. */
export function classifyDesignReview(
  findings: readonly Finding[],
  reviewed: Reviewed,
): DesignReviewResult {
  const files = Object.keys(reviewed);
  const blockers = findings.filter((f) => f.severity === "blocker");
  const summary =
    findings.length === 0
      ? `reviewed ${files.length} file${files.length === 1 ? "" : "s"}, no findings`
      : `${findings.length} finding${findings.length === 1 ? "" : "s"} (${blockers.length} blocker${blockers.length === 1 ? "" : "s"}) over ${files.length} file${files.length === 1 ? "" : "s"}`;

  return {
    code: 0,
    verdict: "pass",
    summary,
    lines: [
      `design-review: RECORDED — ${summary}`,
      ...findingLines(findings),
      ...(blockers.length > 0
        ? [
            "design-review: you recorded a blocker — it is a challenge for the architect to weigh, not a verdict; the freeze does not wait on it and the architect may freeze over it",
          ]
        : [FREEZABLE_NOW]),
      "design-review: this challenges the whole design as it now stands; only ADDING or REMOVING a contract file since re-requires a review — editing one you reviewed does not. The hashes below are provenance:",
      ...files.map((f) => `  ${reviewed[f]!.slice(0, SHORT_HASH)}  ${f}`),
    ],
    // No `findings` count here: the logged event carries the findings
    // THEMSELVES under that key, and one key that means a number in one object
    // and a list in another is a trap for whatever reads the log next.
    detail: {
      blockers: blockers.length,
      severities: findings.map((f) => f.severity),
    },
  };
}

function misuse(reason: string, error: string): DesignReviewResult {
  return {
    code: 2,
    verdict: "error",
    summary: error,
    lines: [`design-review: ERROR — ${error}`],
    detail: { reason },
  };
}

/**
 * Record the reviewer's findings against the design as it stands.
 *
 * The one implementation both the `record_design_review` tool and the CLI go
 * through, so a review cannot differ by how it was invoked.
 */
export function runRecordDesignReview(cwd: string, raw: unknown): DesignReviewResult {
  const parsed = parseFindings(raw);
  if (!parsed.ok) {
    const result = misuse("bad-payload", parsed.error);
    logGuardEvent(cwd, { guard: GUARD, verdict: result.verdict, summary: result.summary, detail: result.detail });
    return result;
  }

  const design = readReviewed(cwd);
  if (!design.ok) {
    const result = misuse(design.reason, design.error);
    logGuardEvent(cwd, { guard: GUARD, verdict: result.verdict, summary: result.summary, detail: result.detail });
    return result;
  }

  const result = classifyDesignReview(parsed.findings, design.reviewed);
  // ONE event, carrying both halves: the claims, and the bytes they are claims
  // about. Splitting them would let a later gate believe a review covered a
  // file it never saw.
  logGuardEvent(cwd, {
    guard: GUARD,
    verdict: result.verdict,
    summary: result.summary,
    detail: { ...result.detail, findings: parsed.findings, reviewed: design.reviewed,
      ticket: activeTicketDesign(cwd)?.ticket },
  });
  return result;
}

// --- CLI ------------------------------------------------------------------------

function main(argv: string[]): number {
  const cwd = argv[0] ?? process.cwd();
  let raw: unknown = [];
  if (argv[1] !== undefined) {
    try {
      raw = JSON.parse(argv[1]);
    } catch {
      console.error("design-review: ERROR — findings argument is not valid JSON");
      return 2;
    }
  }
  const result = runRecordDesignReview(cwd, raw);
  for (const line of result.lines) {
    if (result.code === 0) console.log(line);
    else console.error(line);
  }
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

if (isMainModule()) process.exit(main(process.argv.slice(2)));
