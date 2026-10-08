import { describe, expect, test } from "bun:test";
import type { DecisionIds } from "./judge-event.contract.ts";

/** The behaviour every DecisionIds must have: each id is a DecisionId of non-empty text, and no two are the same. */
export function decisionIdsConformance(name: string, fixture: () => DecisionIds): void {
  describe(`${name} conforms to DecisionIds`, () => {
    test("gives non-empty, distinct ids", () => {
      const ids = fixture();
      const many = Array.from({ length: 100 }, () => ids.next());
      expect(many.every((id) => typeof id.value === "string" && id.value.length > 0)).toBe(true);
      expect(new Set(many.map((id) => id.value)).size).toBe(100);
    });
  });
}
