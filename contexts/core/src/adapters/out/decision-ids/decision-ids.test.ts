import { describe, expect, test } from "bun:test";
import { decisionIdsConformance } from "../../../application/guard-log/judge-event/judge-event.decision-ids.test-support.ts";
import { RandomDecisionIds } from "./decision-ids.ts";

decisionIdsConformance("RandomDecisionIds", () => new RandomDecisionIds());

describe("RandomDecisionIds", () => {
  test("gives a DecisionId each time, never the same twice", () => {
    const ids = new RandomDecisionIds();
    const [a, b] = [ids.next(), ids.next()];
    expect(a.value.length).toBeGreaterThan(0);
    expect(a.equals(a)).toBe(true);
    expect(a.equals(b)).toBe(false);
  });
});
