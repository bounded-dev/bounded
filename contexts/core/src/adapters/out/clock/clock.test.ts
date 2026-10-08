import { describe, expect, test } from "bun:test";
import { clockConformance } from "../../../application/guard-log/judge-event/judge-event.clock.test-support.ts";
import { SystemClock } from "./clock.ts";

clockConformance("SystemClock", () => new SystemClock());

describe("SystemClock", () => {
  test("tells the time as a DecisionTime: an instance equal to itself, its value ISO 8601 in UTC", () => {
    const now = new SystemClock().now();
    expect(now.equals(now)).toBe(true);
    expect(now.value).toBe(new Date(now.value).toISOString());
  });
});
