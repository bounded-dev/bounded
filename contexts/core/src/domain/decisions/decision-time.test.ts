import { describe, expect, test } from "bun:test";
import { DecisionTime } from "./decision-time.ts";

const FORM = "A decision time is ISO 8601 in UTC, as Date.prototype.toISOString writes it, such as 2026-01-02T03:04:05.000Z";

describe("DecisionTime — boundaries", () => {
  test("an ISO 8601 time in UTC, as toISOString writes it", () => {
    const parsed = DecisionTime.parse("2026-10-07T12:00:00.000Z");
    expect(parsed.ok && parsed.value.value).toBe("2026-10-07T12:00:00.000Z");
  });

  test("refuses any other text, or anything else, with one reason", () => {
    for (const raw of ["yesterday", "2026-10-07", "2026-10-07T12:00:00Z", "2026-10-07T12:00:00.000+01:00", 1_700_000_000_000, null]) expect(DecisionTime.parse(raw)).toEqual({ ok: false, error: FORM });
  });
});
