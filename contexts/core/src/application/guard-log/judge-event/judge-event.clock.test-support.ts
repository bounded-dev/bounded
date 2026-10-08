import { describe, expect, test } from "bun:test";
import type { Clock } from "./judge-event.contract.ts";

/** The behaviour every Clock must have. */
export function clockConformance(name: string, fixture: () => Clock): void {
  describe(`${name} conforms to Clock`, () => {
    test("tells the time as an ISO 8601 UTC string", () => {
      const now = fixture().now();
      expect(new Date(now).toISOString()).toBe(now);
    });

    test("never runs backwards", () => {
      const clock = fixture();
      const first = clock.now();
      const second = clock.now();
      expect(Date.parse(second)).toBeGreaterThanOrEqual(Date.parse(first));
    });
  });
}
