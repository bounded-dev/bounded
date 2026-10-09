import { describe, expect, test } from "bun:test";
import { Decision, DecisionId, SessionStart, ToolUse, Verdict } from "bounded/domain";
import type { BoundedLog } from "./judge-event.contract.ts";

/** A decision id from known-good text. */
function decisionId(text: string): DecisionId {
  const parsed = DecisionId.parse(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** What each log technology hands the suite: a fresh log, and its decisions read back as plain data. */
export interface BoundedLogFixture {
  readonly log: BoundedLog;
  recorded(): Promise<readonly unknown[]>;
}

function decisions(): Decision[] {
  const use = ToolUse.parse({ role: "builder", tool: "edit", effects: [{ kind: "write", path: "a.ts", change: "create" }] });
  const start = SessionStart.parse({ role: null });
  if (!use.ok || !start.ok) throw new Error("expected events");
  return [
    Decision.of(decisionId("d-1"), "2026-10-07T12:00:00.000Z", use.value, { verdict: Verdict.allow, refusedBy: null }),
    Decision.of(decisionId("d-2"), "2026-10-07T12:00:01.000Z", start.value, { verdict: Verdict.refuse("No role", "Start as a role"), refusedBy: null }),
    Decision.of(decisionId("d-3"), "2026-10-07T12:00:02.000Z", use.value, { verdict: Verdict.refuse('Generated: "x"\nline two', "Ask"), refusedBy: null }),
  ];
}

/** The behaviour every BoundedLog must have, whatever stores the decisions. */
export function boundedLogConformance(name: string, fixture: () => Promise<BoundedLogFixture>): void {
  describe(`${name} conforms to BoundedLog`, () => {
    test("holds nothing until a decision is recorded", async () => {
      expect(await (await fixture()).recorded()).toEqual([]);
    });

    test("records each decision, whole, in the order recorded", async () => {
      const { log, recorded } = await fixture();
      const all = decisions();
      for (const decision of all) await log.record(decision);
      expect(await recorded()).toEqual(all.map((decision) => JSON.parse(JSON.stringify(decision))));
    });

    test("decisions recorded at once all arrive", async () => {
      const { log, recorded } = await fixture();
      const all = decisions();
      await Promise.all(all.map((decision) => log.record(decision)));
      expect((await recorded()).length).toBe(all.length);
    });
  });
}
