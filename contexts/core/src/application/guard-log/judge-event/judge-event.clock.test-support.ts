import { describe, expect, test } from "bun:test";
import type { Clock } from "./judge-event.contract.ts";

/** The behaviour every Clock must have: it tells the time as a DecisionTime, and never runs backwards. */
export function clockConformance(name: string, fixture: () => Clock): void {
  describe(`${name} conforms to Clock`, () => {
    test("tells the time as a DecisionTime, ISO 8601 in UTC", () => {
      const now = fixture().now();
      expect(now.equals(now)).toBe(true);
      expect(now.value).toBe(new Date(now.value).toISOString());
    });

    test("never runs backwards", () => {
      const clock = fixture();
      const first = clock.now();
      const second = clock.now();
      expect(Date.parse(second.value)).toBeGreaterThanOrEqual(Date.parse(first.value));
    });
  });
}
