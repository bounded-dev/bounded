import { describe, expect, test } from "bun:test";
import { Decision, DecisionId, SessionStart, Verdict } from "bounded/domain";
import type { ProjectBoundedLogs } from "./open-project.contract.ts";

/** A decision id from known-good text. */
function decisionId(text: string): DecisionId {
  const parsed = DecisionId.parse(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** Bounded logs for projects, a project root, and that project's recorded decisions read back. */
export interface ProjectBoundedLogsFixture {
  readonly logs: ProjectBoundedLogs;
  readonly root: string;
  recorded(): Promise<readonly unknown[]>;
}

/** The behaviour every ProjectBoundedLogs must have: a project's log keeps that project's decisions. */
export function projectBoundedLogsConformance(name: string, fixture: () => Promise<ProjectBoundedLogsFixture>): void {
  describe(`${name} conforms to ProjectBoundedLogs`, () => {
    test("a project's log records its decisions", async () => {
      const { logs, root, recorded } = await fixture();
      const start = SessionStart.parse({ role: null });
      if (!start.ok) throw new Error(start.error);
      const decision = Decision.of(decisionId("d-1"), "2026-10-07T12:00:00.000Z", start.value, { verdict: Verdict.allow, refusedBy: null });
      await logs.forProject(root).record(decision);
      expect(await recorded()).toEqual([JSON.parse(JSON.stringify(decision))]);
    });
  });
}
