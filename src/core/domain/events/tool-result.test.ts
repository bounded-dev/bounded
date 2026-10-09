import { describe, expect, test } from "bun:test";
import { wireOf } from "../shared/value-object.laws.test-support.ts";
import { ToolResult } from "./tool-result.ts";

const done = { kind: "tool-result", role: "builder", tool: "shell", effects: [{ kind: "execute", command: "make" }], ok: true, callId: "toolu_1" };


describe("ToolResult", () => {
  test("a tool result is a finished tool use: who, which tool, its effects, the call id and whether it succeeded", () => {
    expect(wireOf(ToolResult.parse(done))).toEqual({
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

  test("a tool result says, for each delegate effect, whether that agent's run finished", () => {
    const delegated = { kind: "tool-result", role: null, tool: "subagent", effects: [{ kind: "delegate", agent: "a" }, { kind: "write", path: "out.md", change: "create" }, { kind: "delegate", agent: "b" }], ok: true, callId: "c1" };
    const parsed = ToolResult.parse({ ...delegated, delegatedAgentRuns: [{ finished: true }, { finished: false }] });
    expect(parsed.ok && parsed.value.delegatedAgentRuns).toEqual([{ finished: true }, { finished: false }]);
    expect(wireOf(parsed)).toEqual({ ok: true, value: { ...delegated, effects: [{ kind: "delegate", agent: "a" }, { kind: "write", path: "out.md", change: "create" }, { kind: "delegate", agent: "b" }], delegatedAgentRuns: [{ finished: true }, { finished: false }] } });
    expect(parsed.ok && Object.isFrozen(parsed.value.delegatedAgentRuns) && Object.isFrozen(parsed.value.delegatedAgentRuns?.[0])).toBe(true);
    // Absent means no run is said to have finished; toJSON writes the list only when given.
    const unsaid = ToolResult.parse(delegated);
    expect(unsaid.ok && unsaid.value.delegatedAgentRuns).toBeUndefined();
    expect(unsaid.ok && Object.keys(unsaid.value.toJSON())).not.toContain("delegatedAgentRuns");
  });

  test("delegatedAgentRuns has one entry per delegate effect", () => {
    const two = { kind: "tool-result", role: null, tool: "subagent", effects: [{ kind: "delegate", agent: "a" }, { kind: "delegate", agent: "b" }], ok: true };
    expect(ToolResult.parse({ ...two, delegatedAgentRuns: [{ finished: true }] })).toEqual({ ok: false, error: "A tool result's delegatedAgentRuns has one entry per delegate effect: 2 effects, 1 entry" });
    expect(ToolResult.parse({ ...done, delegatedAgentRuns: [] })).toEqual({ ok: false, error: "A tool result without a delegate effect has no delegatedAgentRuns" });
    expect(ToolResult.parse({ ...done, delegatedAgentRuns: [{ finished: true }] }).ok).toBe(false);
    expect(ToolResult.parse({ ...two, delegatedAgentRuns: [{ finished: true }, { finished: "yes" }] })).toEqual({ ok: false, error: "A tool result's delegatedAgentRuns entry is { finished }, with finished true or false" });
    expect(ToolResult.parse({ ...two, delegatedAgentRuns: [{ finished: true }, { finished: true, agentRunId: "x" }] }).ok).toBe(false);
    expect(ToolResult.parse({ ...two, delegatedAgentRuns: { finished: true } })).toEqual({ ok: false, error: "A tool result's delegatedAgentRuns is a list of { finished } entries, one per delegate effect" });
  });

  test("an entry may say the host never reports when that agent's runs finish, only for a run not finished", () => {
    const one = { kind: "tool-result", role: null, tool: "subagent", effects: [{ kind: "delegate", agent: "a" }], ok: true };
    const parsed = ToolResult.parse({ ...one, delegatedAgentRuns: [{ finished: false, finishNeverReported: true }] });
    expect(parsed.ok && parsed.value.delegatedAgentRuns).toEqual([{ finished: false, finishNeverReported: true }]);
    expect(wireOf(parsed)).toEqual({ ok: true, value: { ...one, delegatedAgentRuns: [{ finished: false, finishNeverReported: true }] } });
    const never = "A tool result's delegatedAgentRuns entry may say finishNeverReported: true, and only when finished is false";
    expect(ToolResult.parse({ ...one, delegatedAgentRuns: [{ finished: true, finishNeverReported: true }] })).toEqual({ ok: false, error: never });
    expect(ToolResult.parse({ ...one, delegatedAgentRuns: [{ finished: false, finishNeverReported: false }] })).toEqual({ ok: false, error: never });
  });

  test("a tool result's execute effects carry no reading", () => {
    const reading = { outcome: "unread", why: "the parser could not load" };
    expect(ToolResult.parse({ ...done, effects: [{ kind: "execute", command: "make", reading }] })).toEqual({
      ok: false,
      error: "A tool result's execute effects carry no reading: bounded reads a command only when it judges it",
    });
  });

  test("is frozen", () => {
    const parsed = ToolResult.parse(done);
    expect(parsed.ok && Object.isFrozen(parsed.value) && Object.isFrozen(parsed.value.effects)).toBe(true);
  });
});
