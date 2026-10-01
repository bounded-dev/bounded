import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  classifyDesignReview,
  findingLines,
  FREEZABLE_NOW,
  readReviewed,
  recordedFindings,
  runRecordDesignReview,
} from "./design-review.ts";
import { hashContract } from "./checksum-gate.ts";
import { readGuardLog } from "../../../src/guard-log.ts";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import { classifyReviewFreshness } from "./design-gate.ts";

// The reviewer's pen. Two properties carry the whole feature:
//
//   · the record EXISTS whatever the reviewer concluded — including "nothing",
//     because a silence and a clean review are indistinguishable otherwise; and
//   · the record is BOUND to the bytes reviewed, so a design edited after the
//     review is demonstrably stale rather than silently obsolete.
//
// Everything else here is misuse handling: the gate never fails on the CONTENT
// of a finding, so exit 1 does not exist and there is no test for one.

const SPEC = `# Orders

Long enough to be a real document rather than a placeholder: ordering,
arithmetic and its tie-break, identity guarantees.
`;
const CONTRACT = "export interface Order { readonly id: string }\n";

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A project with a spec and `contracts` contract files, unless told otherwise. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-design-review-"));
  tmpDirs.push(dir);
  // Contracts are found under the composed source roots (ADR 2026-056).
  writeProjectPacks(dir, ["ts", "ts-hexagonal"]);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function designed(): string {
  return repo({
    "spec.md": SPEC,
    "contexts/shop/src/orders/orders.contract.ts": CONTRACT,
    "contexts/shop/src/money.contract.ts": CONTRACT,
  });
}

function lastEvent(dir: string) {
  return readGuardLog(dir).at(-1);
}

describe("readReviewed", () => {
  test("covers spec.md and every contract, spec first", () => {
    const r = readReviewed(designed());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.reviewed)).toEqual([
      "spec.md",
      "contexts/shop/src/money.contract.ts",
      "contexts/shop/src/orders/orders.contract.ts",
      "composition:ts",
      "composition:ts-hexagonal",
    ]);
  });

  test("the checksums are checksum-gate's, byte for byte", () => {
    const r = readReviewed(designed());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reviewed["spec.md"]).toBe(hashContract(SPEC));
    expect(r.reviewed["contexts/shop/src/money.contract.ts"]).toBe(hashContract(CONTRACT));
  });

  test("changing selected packs after a review makes that review stale", () => {
    const dir = designed();
    expect(runRecordDesignReview(dir, [])).toMatchObject({ code: 0 });
    const events = readGuardLog(dir);
    writeProjectPacks(dir, ["ts", "ts-hexagonal", "ts-trpc", "ts-web"]);
    const current = readReviewed(dir);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(classifyReviewFreshness(events, current.reviewed)).toMatchObject({
      state: "stale",
      added: ["composition:ts-trpc", "composition:ts-web"],
    });
  });

  test("malformed project composition is a normal review error", () => {
    const dir = designed();
    mkdirSync(join(dir, ".bounded"), { recursive: true });
    writeFileSync(join(dir, ".bounded/composed-packs.json"), "not json\n");
    expect(readReviewed(dir)).toMatchObject({ ok: false, reason: "invalid-composition" });
  });

  test("a design with no spec cannot be reviewed", () => {
    const r = readReviewed(repo({ "contexts/shop/src/x.contract.ts": CONTRACT }));
    expect(r).toMatchObject({ ok: false, reason: "no-spec" });
  });

  test("a design with no contract cannot be reviewed", () => {
    const r = readReviewed(repo({ "spec.md": SPEC }));
    expect(r).toMatchObject({ ok: false, reason: "no-contracts" });
  });
});

describe("classifyDesignReview", () => {
  const reviewed = { "spec.md": "a".repeat(64), "contexts/shop/src/x.contract.ts": "b".repeat(64) };

  test("an empty list is a valid review — 'I found nothing' is a claim", () => {
    const r = classifyDesignReview([], reviewed);
    expect(r.code).toBe(0);
    expect(r.verdict).toBe("pass");
    expect(r.summary).toBe("reviewed 2 files, no findings");
  });

  test("findings are printed with their evidence", () => {
    const r = classifyDesignReview(
      [
        {
          severity: "blocker",
          summary: "OrderId has no parse path — the test-writer cannot construct one",
          evidence: "contexts/shop/src/x.contract.ts:12",
        },
        { severity: "note", summary: "two names for one concept" },
      ],
      reviewed,
    );
    expect(r.summary).toBe("2 findings (1 blocker) over 2 files");
    const text = r.lines.join("\n");
    expect(text).toMatch(/blocker: OrderId has no parse path .* — contexts\/shop\/src\/x\.contract\.ts:12/);
    expect(text).toMatch(/note: two names for one concept/);
  });

  // A COUNT IS AN INDEX INTO A DOCUMENT NOBODY CAN OPEN. r15's architect was
  // handed one, could not find the text, tried `git` three times, and finally
  // revived the reviewer as a subagent to make it recite findings this call
  // had already recorded. So the exact lines are pinned, not merely matched:
  // severity, summary, and evidence, one finding per line.
  test("the result carries every finding verbatim, not just the count", () => {
    const findings = [
      { severity: "blocker" as const, summary: "OrderId has no parse path", evidence: "contexts/shop/src/x.contract.ts:12" },
      { severity: "concern" as const, summary: "prorate() tie-break unstated" },
      { severity: "note" as const, summary: "two names for one concept", evidence: "spec.md" },
    ];
    const lines = classifyDesignReview(findings, reviewed).lines;
    expect(lines.slice(1, 4)).toEqual([
      "  blocker: OrderId has no parse path — contexts/shop/src/x.contract.ts:12",
      "  concern: prorate() tie-break unstated",
      "  note: two names for one concept — spec.md",
    ]);
    // And the same rendering the design_gate step replays, so the architect
    // reads one shape whichever tool showed it.
    expect(findingLines(findings)).toEqual(lines.slice(1, 4));
  });

  // The gate records a challenge; the architect weighs it. A blocker must not
  // read as a verdict, or the reviewer has quietly become a second architect.
  test("a blocker is a challenge for the architect to weigh, not a failure", () => {
    const r = classifyDesignReview([{ severity: "blocker", summary: "uncallable operation" }], reviewed);
    expect(r.code).toBe(0);
    expect(r.verdict).toBe("pass");
    expect(r.lines.join("\n")).toMatch(/challenge for the architect to weigh, not a verdict/);
  });

  // The polish-loop nudge (r15/r16): zero blockers is loud, because the k3
  // architect ran 4-5 review cycles after already getting zero, polishing
  // advisory findings. It changes no verdict — code and verdict stay a pass.
  describe("the 0-blocker freezable-now nudge", () => {
    test("appears when there are no findings at all", () => {
      const r = classifyDesignReview([], reviewed);
      expect(r.code).toBe(0);
      expect(r.verdict).toBe("pass");
      expect(r.lines).toContain(FREEZABLE_NOW);
    });

    test("appears when there are advisory findings but zero blockers — the exact polish case", () => {
      const r = classifyDesignReview(
        [
          { severity: "concern", summary: "prorate() tie-break unstated" },
          { severity: "note", summary: "two names for one concept" },
        ],
        reviewed,
      );
      expect(r.code).toBe(0);
      expect(r.lines).toContain(FREEZABLE_NOW);
    });

    test("is ABSENT when a blocker was recorded — that design is not freezable yet", () => {
      const r = classifyDesignReview([{ severity: "blocker", summary: "uncallable operation" }], reviewed);
      expect(r.lines).not.toContain(FREEZABLE_NOW);
    });
  });

  test("the files reviewed are shown, as provenance, with the file-set rule", () => {
    const text = classifyDesignReview([], reviewed).lines.join("\n");
    expect(text).toContain("spec.md");
    expect(text).toContain("contexts/shop/src/x.contract.ts");
    expect(text).toContain("aaaaaaaaaaaa");
    expect(text).toMatch(/ADDING or REMOVING a contract file/);
  });
});

describe("runRecordDesignReview (guard log)", () => {
  test("the happy path logs ONE design-review event carrying the findings", () => {
    const dir = designed();
    const r = runRecordDesignReview(dir, [
      { severity: "concern", summary: "settleOrder could be read two ways", evidence: "spec.md:41" },
    ]);
    expect(r.code).toBe(0);

    const events = readGuardLog(dir).filter((e) => e.guard === "design-review");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ guard: "design-review", verdict: "pass" });
    expect(events[0]!.detail).toMatchObject({ blockers: 0, severities: ["concern"] });
    expect(JSON.stringify(events[0]!.detail)).toContain("settleOrder could be read two ways");
  });

  test("an empty review is recorded just as loudly — that is the point", () => {
    const dir = designed();
    expect(runRecordDesignReview(dir, []).code).toBe(0);
    const last = lastEvent(dir);
    expect(last).toMatchObject({ guard: "design-review", verdict: "pass" });
    expect(last!.summary).toMatch(/no findings/);
    expect(last!.detail).toMatchObject({ findings: [], blockers: 0, severities: [] });
  });

  // The whole reason the event is worth keeping: it names the exact bytes, so a
  // contract revised after the review can be detected rather than assumed.
  test("the logged event carries a correct checksum for the spec and every contract", () => {
    const dir = designed();
    runRecordDesignReview(dir, []);
    const reviewed = lastEvent(dir)!.detail!["reviewed"] as Record<string, string>;
    expect(Object.keys(reviewed).sort()).toEqual([
      "composition:ts",
      "composition:ts-hexagonal",
      "contexts/shop/src/money.contract.ts",
      "contexts/shop/src/orders/orders.contract.ts",
      "spec.md",
    ]);
    expect(reviewed["spec.md"]).toBe(hashContract(SPEC));
    expect(reviewed["contexts/shop/src/orders/orders.contract.ts"]).toBe(hashContract(CONTRACT));
  });

  test("a revised contract no longer matches the review that covered it", () => {
    const dir = designed();
    runRecordDesignReview(dir, []);
    const before = (lastEvent(dir)!.detail!["reviewed"] as Record<string, string>)[
      "contexts/shop/src/money.contract.ts"
    ];
    writeFileSync(join(dir, "contexts/shop/src/money.contract.ts"), CONTRACT + "export type Cents = number;\n");
    expect(hashContract(CONTRACT + "export type Cents = number;\n")).not.toBe(before);
  });

  test("a malformed payload is misuse, and says what to pass instead", () => {
    const dir = designed();
    const r = runRecordDesignReview(dir, "nope");
    expect(r.code).toBe(2);
    expect(r.lines[0]).toMatch(/pass \[\]/);
    expect(lastEvent(dir)).toMatchObject({ verdict: "error", detail: { reason: "bad-payload" } });
  });

  test("a finding needs a severity and a non-empty summary", () => {
    const dir = designed();
    expect(runRecordDesignReview(dir, [{ severity: "urgent", summary: "x" }]).code).toBe(2);
    expect(runRecordDesignReview(dir, [{ severity: "note", summary: "  " }]).code).toBe(2);
  });

  test("no spec.md is misuse, logged as an error", () => {
    const dir = repo({ "contexts/shop/src/x.contract.ts": CONTRACT });
    const r = runRecordDesignReview(dir, []);
    expect(r.code).toBe(2);
    expect(r.lines[0]).toMatch(/no spec\.md/);
    expect(lastEvent(dir)).toMatchObject({ verdict: "error", detail: { reason: "no-spec" } });
  });

  test("no contract is misuse, logged as an error", () => {
    const dir = repo({ "spec.md": SPEC });
    const r = runRecordDesignReview(dir, []);
    expect(r.code).toBe(2);
    expect(r.lines[0]).toMatch(/no \*\.contract\.ts/);
    expect(lastEvent(dir)).toMatchObject({ verdict: "error", detail: { reason: "no-contracts" } });
  });

  // Misuse must be distinguishable from a recorded review by verdict alone: a
  // later gate asking "has this design been reviewed?" reads the log, and an
  // errored call is not a review.
  test("misuse never records a review a later gate could mistake for one", () => {
    const dir = repo({ "spec.md": SPEC });
    runRecordDesignReview(dir, []);
    expect(readGuardLog(dir).some((e) => e.guard === "design-review" && e.verdict === "pass")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The round trip: what the reviewer records is what the architect can read
// ---------------------------------------------------------------------------
//
// The reviewer holds `record_design_review` and the architect does not, so the
// findings reach the architect only by being written to the guard log here and
// read back by `design_gate`'s review step. That makes the two halves one
// feature, and a detail key renamed on one side would break it silently.

describe("recordedFindings: the guard log carries the claims back out", () => {
  test("a recorded review round-trips its findings, evidence included", () => {
    const dir = repo({ "spec.md": SPEC, "contexts/shop/src/x.contract.ts": CONTRACT });
    const findings = [
      { severity: "blocker", summary: "OrderId has no parse path", evidence: "contexts/shop/src/x.contract.ts:12" },
      { severity: "note", summary: "two names for one concept" },
    ];
    runRecordDesignReview(dir, findings);
    const event = readGuardLog(dir).findLast((e) => e.guard === "design-review");
    expect(recordedFindings(event?.detail)).toEqual(findings);
  });

  test("a detail with no findings, or an unreadable one, replays nothing rather than throwing", () => {
    expect(recordedFindings(undefined)).toEqual([]);
    expect(recordedFindings({ blockers: 1 })).toEqual([]);
    expect(recordedFindings({ findings: "corrupt" })).toEqual([]);
    expect(recordedFindings({ findings: [{ severity: "urgent", summary: "x" }] })).toEqual([]);
  });
});
