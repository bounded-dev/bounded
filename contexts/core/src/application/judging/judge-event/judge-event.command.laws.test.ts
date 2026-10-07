import { describe, expect, test } from "bun:test";
import { Event } from "bounded/domain";
import { JudgeEventCommand } from "./judge-event.command.ts";

describe("JudgeEventCommand laws", () => {
  test("validates the event exactly as Event.parse does", () => {
    for (const raw of [
      { kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "a.ts" }] },
      { kind: "session-start", role: "builder" },
      { kind: "tool-use", role: null, tool: "read", effects: [] },
      { kind: "session-end", role: null },
      null,
    ]) {
      const expected = Event.parse(raw);
      const result = JudgeEventCommand.parse(raw);
      if (!expected.ok) {
        expect(result).toEqual(expected);
        continue;
      }
      expect(result.ok && result.value.event).toEqual(expected.value);
    }
  });
});
