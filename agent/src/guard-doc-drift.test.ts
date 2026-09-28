import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { contributedSrcRuleIds, SRC_RULE_IDS, TEST_RULE_IDS } from "../packs/ts/scripts/lint-src.ts";
import { CONTRACT_RULE_IDS, contributedContractRuleIds } from "../packs/ts/scripts/contract-purity.ts";
import { DESIGN_STEPS } from "../packs/ts/scripts/design-gate.ts";
import { GATE_TOOLS, ROLE_TOOLS } from "./path-policy.ts";

// The deterministic-check principle runs both ways. Forward: every rule that
// must hold is enforced by a guard, because prose executes unreliably (the
// whole dogfood record). Backward — THIS file: everything a guard enforces on
// a role must also be TOLD to that role in its brief, so the agent can get it
// right the first time instead of learning the rule from a block. A guard the
// agent has never heard of is a bounce tax paid on every run.
//
// The check is presence-by-name: the rule id (or its distinctive tail) must
// appear in the role's .md. Wording is free; silence is not.

const agents = join(import.meta.dirname, "..", "agents");
const builder = readFileSync(join(agents, "builder.md"), "utf8");
const testWriter = readFileSync(join(agents, "test-writer.md"), "utf8");
const architect = readFileSync(join(agents, "architect.md"), "utf8");
const reviewer = readFileSync(join(agents, "reviewer.md"), "utf8");
const developerStage = readFileSync(
  join(import.meta.dirname, "..", "skills", "developer-stage", "SKILL.md"),
  "utf8",
);

/** Match by the id's distinctive tail so prose may write `no-explicit-any`
 *  without the plugin prefix. */
function names(doc: string, ruleId: string): boolean {
  const tail = ruleId.split("/").pop()!;
  return doc.includes(tail);
}

describe("every enforced rule is named in the brief of the role it binds", () => {
  test("src rules → builder.md", () => {
    const missing = SRC_RULE_IDS.filter((r) => !names(builder, r));
    expect(missing).toEqual([]);
  });

  test("test rules → test-writer.md", () => {
    const missing = TEST_RULE_IDS.filter((r) => !names(testWriter, r));
    expect(missing).toEqual([]);
  });

  test("contract rules → architect.md", () => {
    const missing = CONTRACT_RULE_IDS.filter((r) => !names(architect, r));
    expect(missing).toEqual([]);
  });

  // Contract rules a pack contributes through `contractPurityOverrides` bind
  // the architect exactly as the built-in ones do, so they are named there too.
  test("contributed contract rules → architect.md", () => {
    const contributed = contributedContractRuleIds();
    expect(contributed.length).toBeGreaterThan(0);
    expect(contributed.filter((r) => !names(architect, r))).toEqual([]);
  });

  // A rule a PACK contributed through the ts pack's `lintSrcRules` socket
  // (TN-26-005) is enforced by exactly the same gate, in exactly the same flat
  // config, at exactly the same severity as a built-in one — so it carries
  // exactly the same obligation (ADR 2026-018). The contribution names the
  // brief itself, so this check needs no list of packs and no list of rules:
  // composing a new pack that contributes a rule its brief does not mention
  // turns this test red on the spot.
  const briefs: Readonly<Record<string, string>> = { builder, "test-writer": testWriter };

  test("contributed rules → the brief each one names", () => {
    const missing = contributedSrcRuleIds().filter(({ id, namedIn }) => {
      const doc = briefs[namedIn];
      return doc === undefined || !names(doc, id);
    });
    expect(missing).toEqual([]);
  });

  // Guard against the empty-set pass. A check over nothing goes green through a
  // broken registry, a mis-wired composition, or a socket read that quietly
  // returned [] — the exact failures the test above exists to notice.
  test("there are contributed rules to check (the socket is actually wired)", () => {
    expect(contributedSrcRuleIds().length).toBeGreaterThan(0);
  });
});

describe("the obligations and orderings are named too", () => {
  test("test-writer is told about reachability, boundaries, and collection-time throws", () => {
    expect(testWriter).toMatch(/boundaries/);
    expect(testWriter).toMatch(/— boundaries/); // the exact describe fingerprint, em dash
    expect(testWriter).toMatch(/top level of a test file|during import/);
    expect(testWriter).toMatch(/must be CALLED|reachab/i);
  });

  test("builder is told about surface conformance and the ceilings' remedy", () => {
    expect(builder).toMatch(/match the\ncontract exactly|match the contract exactly/);
    expect(builder).toMatch(/CONTRACT-DISPUTE/);
  });

  test("architect is told green requires a red after the last freeze", () => {
    expect(architect).toMatch(/red_gate. pass exists\nAFTER|pass exists AFTER|after the most recent/i);
  });
});

// The same bidirectional rule applied to the ROSTER rather than to lint rules.
// The architect has no `bash`, so its tool list IS its set of capabilities: a
// gate it holds but was never told about is a capability it will not use, and a
// tool the docs still name but nothing registers is an instruction to make a
// call that cannot succeed. `developer-stage/SKILL.md` is the operational
// source of truth the architect brief defers to, so it is the document pinned.
describe("the gate roster and the brief that drives it agree", () => {
  test("every gate tool is named in the developer-stage skill", () => {
    const missing = GATE_TOOLS.filter((t) => !developerStage.includes(t));
    expect(missing).toEqual([]);
  });

  // `scaffold` and `freeze_contracts` are steps of `design_gate` (ADR
  // 2026-019), not tools. The prose may still name the STEPS — it has to, since
  // the gate reports them — so the check is on the backticked tool-call form.
  test("no retired tool is still offered as a call", () => {
    for (const retired of ["scaffold", "freeze_contracts"]) {
      expect(developerStage, `SKILL.md still calls \`${retired}\``).not.toContain(`\`${retired}\``);
      expect(architect, `architect.md still calls \`${retired}\``).not.toContain(`\`${retired}\``);
    }
  });

  // The reviewer has no `bash` and no pen, so its tool list IS its set of
  // capabilities — and the list is short enough that a brief which failed to
  // name one would be describing a different role.
  test("every tool the reviewer holds is named in its brief", () => {
    const BUILTIN = new Set(["read", "grep", "find", "ls"]);
    const missing = ROLE_TOOLS.reviewer.filter((t) => !BUILTIN.has(t) && !reviewer.includes(t));
    expect(missing).toEqual([]);
  });

  // ADR 2026-014: structure, not persona. The brief earns its place by being a
  // checklist with greppable lead phrases and an explicit stop — the two things
  // measurably reproduced in output — so pin the fingerprint, not the wording.
  test("the reviewer's brief is a checklist with the severities it must choose between", () => {
    expect(reviewer).toMatch(/## The checklist/);
    for (const severity of ["blocker", "concern", "note"]) {
      expect(reviewer, `the brief must say what '${severity}' means`).toContain(severity);
    }
    expect(reviewer).toMatch(/empty list is a valid review/);
  });

  test("the architect is told design_gate is the one design-phase call", () => {
    expect(architect).toContain("design_gate");
    expect(developerStage).toMatch(/design_gate/);
  });

  // Same bidirectional rule, applied to the SEQUENCE: a step that can block the
  // phase and is named nowhere in the brief is a step the architect meets for
  // the first time as a block. The check is presence-by-name, so a step added
  // to the composite cannot land without the procedure mentioning it.
  test("every step design_gate runs is named in the brief that drives it", () => {
    const missing = DESIGN_STEPS.filter((step) => !developerStage.includes(step));
    expect(missing).toEqual([]);
  });

  // The freshness lock is a rule the architect cannot discover by trying: the
  // reviewer is a role it has to know to commission, and the voiding rule is
  // the difference between one review and one per revision.
  test("both briefs name the reviewer, its recorder, and what voids a review", () => {
    for (const [name, doc] of [
      ["architect.md", architect],
      ["developer-stage/SKILL.md", developerStage],
    ] as const) {
      expect(doc, `${name} must name the reviewer role`).toMatch(/`reviewer`/);
      expect(doc, `${name} must name the recording tool`).toContain("record_design_review");
      expect(doc, `${name} must say an edit voids the review`).toMatch(
        /voids the review|unreviewed (design|contract)|stale by construction/,
      );
    }
  });

  // Findings are advisory (ADR 2026-020): a brief that let the architect read a
  // blocker as a verdict would have re-invented the reviewer as a second
  // architect, which is exactly what the role must not become.
  test("both briefs say the findings are the architect's to settle", () => {
    expect(architect).toMatch(/claims for you to settle|you settle/);
    expect(developerStage).toMatch(/claims, not verdicts/);
  });
});
