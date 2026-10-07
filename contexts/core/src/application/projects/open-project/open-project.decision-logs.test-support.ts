import { describe, expect, test } from "bun:test";
import { Decision, SessionStart, Verdict } from "bounded/domain";
import type { ProjectDecisionLogs } from "./open-project.contract.ts";

/** Decision logs for projects, a project root, and that project's recorded decisions read back. */
export interface DecisionLogsFixture {
  readonly logs: ProjectDecisionLogs;
  readonly root: string;
  recorded(): Promise<readonly unknown[]>;
}

/** The behaviour every ProjectDecisionLogs must have: a project's log keeps that project's decisions. */
export function projectDecisionLogsConformance(name: string, fixture: () => Promise<DecisionLogsFixture>): void {
  describe(`${name} conforms to ProjectDecisionLogs`, () => {
    test("a project's log records its decisions", async () => {
      const { logs, root, recorded } = await fixture();
      const start = SessionStart.parse({ role: null });
      if (!start.ok) throw new Error(start.error);
      const decision = Decision.of("d-1", "2026-10-07T12:00:00.000Z", start.value, { verdict: Verdict.allow, refusedBy: null });
      await logs.forProject(root).record(decision);
      expect(await recorded()).toEqual([JSON.parse(JSON.stringify(decision))]);
    });
  });
}
