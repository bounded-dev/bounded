// sign-off gate (TN-26-001, the terminal verdict).
//
//   node sign-off.ts [targetDir] '<findings json>'
//
// GREEN IS NOT THE TERMINAL VERDICT. Dogfood Run 7 shipped a runtime contract
// violation that its own architect had already found: its closing turn reasoned
// through the non-null assertion in `renew`/`changePlan`, observed that the
// replay branch returns an undefined invoice, noted "the test writer didn't test
// it", and then concluded — verbatim — "Given the green gate passed, we can
// declare done." The user-facing report mentioned none of it.
//
// That is not a model failure. A correct, human-grade judgement was made and
// discarded because the loop had exactly one terminal state and it was a gate
// verdict. There was nowhere to put a finding that was not itself a gate
// failure, so the finding evaporated.
//
// So the loop ends here instead. After a green gate the architect must record
// what it saw — AN EMPTY LIST IS A VALID ANSWER, and saying so explicitly is the
// point: it is a claim the architect makes and the guard log keeps, rather than
// a silence nobody can audit later. Cost is one turn.
//
// This gate deliberately does NOT judge the findings. It cannot: whether a
// finding is real is exactly the question the reviewer role (still unbuilt) is
// meant to answer. What it does is make the answer exist, in a greppable line,
// so a later run can ask whether these findings were any good.
//
// Exit 0 recorded · 1 refused (no green to sign off) · 2 misuse (bad payload).

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { logGuardEvent, readGuardLog } from "../../../src/guard-log.ts";
import type { GateResult } from "../../../src/gate-result.ts";

const GUARD = "sign-off";

/** How much the architect thinks the finding matters. The gate records the
 *  claim; it never second-guesses it. */
export type FindingSeverity = "blocker" | "concern" | "note";

export interface Finding {
  readonly severity: FindingSeverity;
  /** One line: what is wrong. */
  readonly summary: string;
  /** Where to look — a path, a symbol, a test name. Optional but wanted. */
  readonly evidence?: string;
}

const SEVERITIES: readonly string[] = ["blocker", "concern", "note"];

/** The shape of one finding, appended to every payload error: an error that
 *  names only the failing field sends the caller back to guess the rest
 *  (issue #48: two malformed payloads in a row before one passed). */
export const FINDING_SHAPE =
  '— each finding is {"severity": "blocker | concern | note", "summary": "…", "evidence": "…"}';

/** Validate the payload. Pure: no I/O, no logging. A malformed payload is
 *  misuse (exit 2), not a refusal — the architect gets to try again. */
export function parseFindings(raw: unknown): { ok: true; findings: Finding[] } | { ok: false; error: string } {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error: `${error} ${FINDING_SHAPE}` });
  if (!Array.isArray(raw)) {
    return fail("findings must be an array — pass [] to record that you found nothing");
  }
  const findings: Finding[] = [];
  for (const [i, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) {
      return fail(`findings[${i}] must be an object with 'severity' and 'summary'`);
    }
    const { severity, summary, evidence } = item as Record<string, unknown>;
    if (typeof severity !== "string" || !SEVERITIES.includes(severity)) {
      return fail(`findings[${i}].severity must be one of ${SEVERITIES.join(" | ")}`);
    }
    if (typeof summary !== "string" || summary.trim() === "") {
      return fail(`findings[${i}].summary must be a non-empty line saying what is wrong`);
    }
    if (evidence !== undefined && typeof evidence !== "string") {
      return fail(`findings[${i}].evidence must be a string (a path, a symbol, a test name)`);
    }
    findings.push(
      evidence === undefined
        ? { severity: severity as FindingSeverity, summary }
        : { severity: severity as FindingSeverity, summary, evidence },
    );
  }
  return { ok: true, findings };
}

/** Has a green gate passed in this project? Sign-off before green is
 *  meaningless — there is nothing to sign off on. */
export function hasPassingGreen(events: readonly { guard: string; verdict: string }[]): boolean {
  return events.some((e) => e.guard === "green-gate" && e.verdict === "pass");
}

/** Format the verdict. Pure. */
export function classifySignOff(findings: readonly Finding[], greenPassed: boolean): GateResult {
  if (!greenPassed) {
    return {
      code: 1,
      verdict: "block",
      summary: "sign-off before a passing green gate",
      lines: [
        "sign-off: FAIL — no passing green gate in this project's guard log; there is nothing to sign off on",
        "sign-off: run green_gate first, and sign off on the verdict it produced",
      ],
      detail: { reason: "no-green" },
    };
  }

  const blockers = findings.filter((f) => f.severity === "blocker");
  const summary =
    findings.length === 0
      ? "signed off, no findings"
      : `signed off with ${findings.length} finding${findings.length === 1 ? "" : "s"} (${blockers.length} blocker${blockers.length === 1 ? "" : "s"})`;

  return {
    code: 0,
    verdict: "pass",
    summary,
    lines: [
      `sign-off: RECORDED — ${summary}`,
      ...findings.map((f) => `  ${f.severity}: ${f.summary}${f.evidence ? ` — ${f.evidence}` : ""}`),
      ...(blockers.length > 0
        ? ["sign-off: you recorded a blocker; say so to the user rather than reporting a clean green"]
        : []),
    ],
    detail: { findings: findings.length, blockers: blockers.length, severities: findings.map((f) => f.severity) },
  };
}

/** Record the terminal verdict. The one implementation both the tool and the
 *  CLI go through. */
export function runSignOff(cwd: string, raw: unknown): GateResult {
  const parsed = parseFindings(raw);
  if (!parsed.ok) {
    const result: GateResult = {
      code: 2,
      verdict: "error",
      summary: parsed.error,
      lines: [`sign-off: ERROR — ${parsed.error}`],
      detail: { reason: "bad-payload" },
    };
    logGuardEvent(cwd, { guard: GUARD, verdict: result.verdict, summary: result.summary, detail: result.detail });
    return result;
  }

  const result = classifySignOff(parsed.findings, hasPassingGreen(readGuardLog(cwd)));
  logGuardEvent(cwd, {
    guard: GUARD,
    verdict: result.verdict,
    summary: result.summary,
    detail: { ...result.detail, findings: parsed.findings },
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
      console.error("sign-off: ERROR — findings argument is not valid JSON");
      return 2;
    }
  }
  const result = runSignOff(cwd, raw);
  for (const line of result.lines) console.log(line);
  return result.code;
}

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
