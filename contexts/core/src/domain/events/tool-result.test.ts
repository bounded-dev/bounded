import { describe, expect, test } from "bun:test";
import { ToolResult } from "./tool-result.ts";

const done = { kind: "tool-result", role: "builder", tool: "shell", effects: [{ kind: "execute", command: "make" }], ok: true, callId: "toolu_1" };

describe("ToolResult", () => {
  test("a tool result is a finished tool use: who, which tool, its effects, the call id and whether it succeeded", () => {
    expect<unknown>(ToolResult.parse(done)).toEqual({
      ok: true,
      value: { kind: "tool-result", role: "builder", tool: "shell", effects: [{ kind: "execute", command: "make", cwd: null }], ok: true, callId: "toolu_1" },
    });
    const failed = ToolResult.parse({ ...done, ok: false });
    expect(failed.ok && failed.value.ok).toBe(false);
  });

  test("is checked like a tool use", () => {
    expect(ToolResult.parse({ ...done, effects: [] })).toEqual({
      ok: false,
      error: "A tool use's effects must be a non-empty list of what the call reads, lists, writes, executes, fetches, delegates or invokes",
    });
    expect(ToolResult.parse({ ...done, role: "Builder" }).ok).toBe(false);
    expect(ToolResult.parse({ ...done, callId: "" }).ok).toBe(false);
  });

  test("says whether the tool succeeded", () => {
    const { ok: _ok, ...unsaid } = done;
    expect(ToolResult.parse(unsaid)).toEqual({ ok: false, error: "A tool result says whether the tool succeeded: ok is true or false" });
  });

  test("has kind tool-result, never another", () => {
    expect(ToolResult.parse({ ...done, kind: "tool-use" })).toEqual({ ok: false, error: "A tool result has kind 'tool-result', not 'tool-use'" });
    for (const raw of [null, "x", []]) expect(ToolResult.parse(raw).ok).toBe(false);
  });

  test("is frozen", () => {
    const parsed = ToolResult.parse(done);
    expect(parsed.ok && Object.isFrozen(parsed.value) && Object.isFrozen(parsed.value.effects)).toBe(true);
  });
});
