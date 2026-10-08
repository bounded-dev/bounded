import { describe, expect, test } from "bun:test";
import { Event } from "./event.ts";

const write = { kind: "tool-use", role: "builder", tool: "write", effects: [{ kind: "write", path: "a.ts", change: "create" }] };
const start = { kind: "session-start", role: "builder" };


describe("Event — boundaries", () => {
  test("an event is a tool use or a session start, chosen by its kind", () => {
    const tool = Event.parse(write);
    expect(tool.ok && tool.value.kind).toBe("tool-use");
    const session = Event.parse(start);
    expect(session.ok && session.value.kind).toBe("session-start");
  });

  test("refuses an event of another or no kind, naming the kinds there are", () => {
    for (const raw of [{ kind: "session-end", role: null }, { role: null }, "tool-use", null]) {
      expect(Event.parse(raw)).toEqual({ ok: false, error: "An event has kind 'tool-use' or 'session-start'" });
    }
  });

  test("refuses an event whose effect is invalid, naming the effect and why", () => {
    const result = Event.parse({ kind: "tool-use", role: null, tool: "edit", effects: [{ kind: "write", path: "../x", change: "create" }] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("Effect 1 of 1: Path '../x' climbs out of the project with '..'. Only paths inside the project can be checked");
  });

  test("refuses a malformed event of a known kind with that kind's reason", () => {
    expect(Event.parse({ ...write, tool: "bash" })).toEqual({ ok: false, error: "Tool kind 'bash' is not one of: read, search, edit, write, shell, web, subagent, other" });
  });
});

describe("Event — never throws", () => {
  test("refuses an input whose kind cannot be read, saying so", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("trap"); }, has: () => { throw new Error("trap"); }, getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    expect(Event.parse(hostile)).toEqual({ ok: false, error: "An event could not be read: trap" });
  });

  test("reads only its own kind, never an inherited one", () => {
    expect(Event.parse(Object.create(start))).toEqual({ ok: false, error: "An event has kind 'tool-use' or 'session-start'" });
  });
});
