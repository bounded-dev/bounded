import { describe, expect, test } from "bun:test";
import type { DecisionIds } from "./judge-event.contract.ts";

/** The behaviour every DecisionIds must have: each id is non-empty text, and no two are the same. */
export function decisionIdsConformance(name: string, fixture: () => DecisionIds): void {
  describe(`${name} conforms to DecisionIds`, () => {
    test("gives non-empty, distinct ids", () => {
      const ids = fixture();
      const many = Array.from({ length: 100 }, () => ids.next());
      expect(many.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
      expect(new Set(many).size).toBe(100);
    });
  });
}
