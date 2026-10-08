import { describe, expect, test } from "bun:test";
import { wireOf } from "../shared/value-object.laws.test-support.ts";
import { SessionStart } from "./session-start.ts";


describe("SessionStart — boundaries", () => {
  test("a session start names the role it starts, or null", () => {
    expect(wireOf(SessionStart.parse({ role: "planner" }))).toEqual({ ok: true, value: { kind: "session-start", role: "planner" } });
    expect(wireOf(SessionStart.parse({ role: null }))).toEqual({ ok: true, value: { kind: "session-start", role: null } });
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

describe("SessionStart — never throws", () => {
  test("refuses an input whose fields cannot be read, saying so", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("trap"); }, has: () => { throw new Error("trap"); }, getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    expect(SessionStart.parse(hostile)).toEqual({ ok: false, error: "A session start could not be read: trap" });
    const getter = Object.defineProperty({ ...{ role: "planner" } }, "role", { enumerable: true, get: () => { throw new Error("no role"); } });
    expect(SessionStart.parse(getter)).toEqual({ ok: false, error: "A session start could not be read: no role" });
  });

  test("a field whose text cannot be printed is refused, not thrown", () => {
    const trap = { toString: () => { throw new Error("no"); } };
    expect(SessionStart.parse({ ...{ role: "planner" }, kind: trap }).ok).toBe(false);
  });

  test("reads only its own fields, never inherited ones", () => {
    expect(SessionStart.parse(Object.create({ role: "planner" })).ok).toBe(false);
  });
});
