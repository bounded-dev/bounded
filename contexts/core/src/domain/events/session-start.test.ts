import { describe, expect, test } from "bun:test";
import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { SessionStart } from "./session-start.ts";

valueObjectLaws("SessionStart", SessionStart, [{ role: "planner" }, { role: null }], [{}, { role: "" }, { role: 1 }, { kind: "tool-use", role: null }]);

describe("SessionStart — boundaries", () => {
  test("a session start names the role it starts, or null", () => {
    expect<unknown>(SessionStart.parse({ role: "planner" })).toEqual({ ok: true, value: { kind: "session-start", role: "planner" } });
    expect<unknown>(SessionStart.parse({ role: null })).toEqual({ ok: true, value: { kind: "session-start", role: null } });
  });

  test("refuses an invalid or missing role with an actionable reason", () => {
    expect(SessionStart.parse({ role: "" })).toEqual({ ok: false, error: "Role '' must be lowercase words joined by single hyphens, such as 'builder'" });
    expect(SessionStart.parse({})).toEqual({ ok: false, error: "A session start must name its role: a role label, or null when no role is active" });
  });

  test("refuses something that is not a session start", () => {
    expect(SessionStart.parse("planner")).toEqual({ ok: false, error: "A session start is an object: { role }" });
    expect(SessionStart.parse({ kind: "tool-use", role: null })).toEqual({ ok: false, error: "A session start has kind 'session-start', not 'tool-use'" });
  });

  test("is frozen", () => {
    const result = SessionStart.parse({ role: null });
    expect(result.ok && Object.isFrozen(result.value)).toBe(true);
  });
});
