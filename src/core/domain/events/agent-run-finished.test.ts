import { describe, expect, test } from "bun:test";
import { wireOf } from "../shared/value-object.laws.test-support.ts";
import { AgentRunFinished } from "./agent-run-finished.ts";
import { Event } from "./event.ts";

const finish = { kind: "agent-run-finished", role: "builder", agent: "plan-reviewer", agentRunId: "a6eef1505a0b443a2", ranToEnd: null };

describe("AgentRunFinished", () => {
  test("an agent run's finish names the session's role, the agent the host ran, the run's id, and whether it ran to its end, null when the host does not say", () => {
    for (const ranToEnd of [null, true, false]) {
      const parsed = AgentRunFinished.parse({ ...finish, ranToEnd });
      expect(wireOf(parsed)).toEqual({ ok: true, value: { ...finish, ranToEnd } });
      expect(parsed.ok && parsed.value.ranToEnd).toBe(ranToEnd);
    }
    const parsed = AgentRunFinished.parse(finish);
    expect(parsed.ok && Object.keys(parsed.value.toJSON()).sort()).toEqual(["agent", "agentRunId", "kind", "ranToEnd", "role"]);
    expect(parsed.ok && parsed.value.agent.value).toBe("plan-reviewer");
    expect(parsed.ok && parsed.value.agentRunId.value).toBe("a6eef1505a0b443a2");
    expect(parsed.ok && parsed.value.role?.value).toBe("builder");
    const { kind: _kind, ...withoutKind } = finish;
    expect(wireOf(AgentRunFinished.parse({ ...withoutKind, role: null }))).toEqual({ ok: true, value: { ...finish, role: null } });
  });

  test("whether it ran to its end must be given: true, false or null", () => {
    const { ranToEnd: _ranToEnd, ...unsaid } = finish;
    const error = "An agent run's finish says whether it ran to its end: ranToEnd is true, false or null";
    expect(AgentRunFinished.parse(unsaid)).toEqual({ ok: false, error });
    expect(AgentRunFinished.parse({ ...finish, ranToEnd: "yes" })).toEqual({ ok: false, error });
  });

  test("a finish names its agent and its run", () => {
    const blankAgent = AgentRunFinished.parse({ ...finish, agent: "" });
    expect(blankAgent.ok ? "" : blankAgent.error).toStartWith("An agent run's finish's agent: ");
    const blankRun = AgentRunFinished.parse({ ...finish, agentRunId: " " });
    expect(blankRun).toEqual({ ok: false, error: "An agent run's finish's agentRunId: An agent run id is non-empty text without control characters, at most 256 characters" });
    const { role: _role, ...roleless } = finish;
    expect(AgentRunFinished.parse(roleless)).toEqual({ ok: false, error: "An agent run's finish must name its role: a role label, or null when no role is active" });
  });

  test("has kind agent-run-finished, never another", () => {
    expect(AgentRunFinished.parse({ ...finish, kind: "tool-use" })).toEqual({ ok: false, error: "An agent run's finish has kind 'agent-run-finished', not 'tool-use'" });
    for (const raw of [null, "finished", []]) expect(AgentRunFinished.parse(raw).ok).toBe(false);
  });

  test("is not an event the guards judge", () => {
    expect(Event.parse(finish).ok).toBe(false);
  });

  test("is frozen", () => {
    const parsed = AgentRunFinished.parse(finish);
    expect(parsed.ok && Object.isFrozen(parsed.value)).toBe(true);
  });

  test("refuses an input whose fields cannot be read, never throwing", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("trap"); }, has: () => { throw new Error("trap"); }, getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    expect(AgentRunFinished.parse(hostile)).toEqual({ ok: false, error: "An agent run's finish could not be read: trap" });
  });
});
