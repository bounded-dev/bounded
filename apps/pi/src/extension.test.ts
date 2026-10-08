import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ToolResult, Verdict } from "bounded/domain";
import type { ToolUse } from "./event.ts";
import { type AdapterRefusal, type ProjectJudgeForPi, type ExtensionOptions, type LoadJudge, type Pi, type PiHandler, piExtension } from "./extension.ts";
import { bounded } from "./index.ts";

/** A value's wire form: its JSON, parsed. */
const wireOf = (value: unknown): unknown => JSON.parse(JSON.stringify(value) ?? "null");

const project = mkdtempSync(join(tmpdir(), "bounded-pi-extension-"));
mkdirSync(join(project, "generated"), { recursive: true });
writeFileSync(join(project, "generated", "api.ts"), "");

/** A stand-in for pi: records handlers, and emits events to them as pi would, awaiting each. */
function fakePi() {
  const handlers = new Map<string, PiHandler[]>();
  const pi: Pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  const emit = (event: string, payload: unknown, context: unknown = { cwd: project }) => Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, context)));
  const start = () => emit("session_start", { type: "session_start", reason: "startup" });
  const call = async (toolName: string, input: unknown, context?: unknown) => (await emit("tool_call", { type: "tool_call", toolCallId: "1", toolName, input }, context))[0];
  const finished = async (toolName: string, input: unknown, isError = false) =>
    (await emit("tool_result", { type: "tool_result", toolCallId: "1", toolName, input, content: [{ type: "text", text: "done" }], isError }))[0];
  return { pi, handlers, start, call, finished };
}

// The decide a composed project would give: refuse writes under generated/.
const seen: ToolUse[] = [];
const noGenerated: ProjectJudgeForPi = async (event) => {
  seen.push(event);
  return event.effects.some((effect) => effect.kind === "write" && effect.path.value.startsWith("generated/"))
    ? Verdict.refuse("generated/ is written by the generator", "Change the generator's input instead")
    : Verdict.allow;
};
const loads = (decide: ProjectJudgeForPi): LoadJudge => async () => decide;
const never = <T>(): Promise<T> => new Promise<T>(() => {});

async function started(load: LoadJudge, deadlines: Pick<ExtensionOptions, "deadlineMs" | "composeDeadlineMs" | "composeBackoffMs"> = {}) {
  const fake = fakePi();
  piExtension({ projectRoot: project, load, home: "/home/agent", ...deadlines })(fake.pi);
  await fake.start();
  return fake;
}

describe("piExtension — end to end through a fake pi", () => {
  test("registers for session_start, tool_call and tool_result only", () => {
    const fake = fakePi();
    piExtension({ projectRoot: project, load: loads(noGenerated) })(fake.pi);
    expect([...fake.handlers.keys()].sort()).toEqual(["session_start", "tool_call", "tool_result"]);
  });

  test("an allowed call returns undefined, so pi runs it", async () => {
    const fake = await started(loads(noGenerated));
    expect(await fake.call("read", { path: "generated/api.ts" })).toBeUndefined();
    expect(wireOf(seen.at(-1))).toEqual({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "generated/api.ts" }], callId: "1" });
  });

  test("a refused call blocks, with the reason and the redirect on separate lines", async () => {
    const fake = await started(loads(noGenerated));
    expect(await fake.call("edit", { path: join(project, "generated", "api.ts"), edits: [] })).toEqual({
      block: true,
      reason: "generated/ is written by the generator\nChange the generator's input instead",
    });
  });

  test("the session's cwd from pi's context is where relative paths start", async () => {
    const fake = await started(loads(noGenerated));
    expect(await fake.call("write", { path: "api.ts" }, { cwd: join(project, "generated") })).toMatchObject({ block: true });
  });

  test("composes once per session start, not per call", async () => {
    let count = 0;
    const fake = await started(async () => {
      count += 1;
      return noGenerated;
    });
    await fake.call("read", { path: "a.ts" });
    await fake.call("read", { path: "b.ts" });
    expect(count).toBe(1);
    await fake.start();
    expect(count).toBe(2);
  });

  test("a shell call's execute effect carries the session's directory, project-relative", async () => {
    const fake = await started(loads(noGenerated));
    await fake.call("bash", { command: "ls" }, { cwd: join(project, "generated") });
    expect(wireOf(seen.at(-1))).toEqual({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command: "ls", cwd: "generated" }], callId: "1" });
  });

  test("an allowed call's input is frozen, so a later handler cannot change what was judged", async () => {
    const fake = await started(loads(noGenerated));
    const input = { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] };
    expect(await fake.call("edit", input)).toBeUndefined();
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.edits[0])).toBe(true);
    expect(() => {
      (input as { path: string }).path = "generated/api.ts";
    }).toThrow();
  });
});

describe("piExtension — after a tool ran, and refusals the adapter makes", () => {
  const withExtras = (extras: Pick<ProjectJudgeForPi, "afterTool" | "refuse">): LoadJudge => async () => Object.assign(async (event: ToolUse) => noGenerated(event), extras);

  test("a finished call is given to afterTool as a tool result with pi's call id", async () => {
    const results: ToolResult[] = [];
    const fake = await started(withExtras({ afterTool: async (result) => {
      results.push(result);
      return { message: null };
    } }));
    expect(await fake.finished("bash", { command: "./regenerate.sh" })).toBeUndefined();
    expect(wireOf(results)).toEqual([{ kind: "tool-result", role: null, tool: "shell", effects: [{ kind: "execute", command: "./regenerate.sh", cwd: "." }], ok: true, callId: "1" }]);
  });

  test("what afterTool undid is added to the result pi gives the agent, marked as an error", async () => {
    const fake = await started(withExtras({ afterTool: async () => ({ message: "This command changed protected files, and they were restored: generated/api.ts was modified." }) }));
    expect(await fake.finished("bash", { command: "./regenerate.sh" })).toEqual({
      content: [{ type: "text", text: "done" }, { type: "text", text: "This command changed protected files, and they were restored: generated/api.ts was modified." }],
      isError: true,
    });
  });

  test("a failed tool, one bounded cannot translate, and a project with no afterTool are still checked or left alone", async () => {
    const results: ToolResult[] = [];
    const fake = await started(withExtras({ afterTool: async (result) => {
      results.push(result);
      return { message: null };
    } }));
    await fake.finished("read", { path: "../outside.txt" }, true);
    expect(wireOf(results)).toEqual([{ kind: "tool-result", role: null, tool: "other", effects: [{ kind: "invoke", name: "read" }], ok: false, callId: "1" }]);
    expect(await (await started(loads(noGenerated))).finished("bash", { command: "ls" })).toBeUndefined();
  });

  const resultOf = async (input: unknown): Promise<ToolResult | undefined> => {
    const results: ToolResult[] = [];
    const fake = await started(withExtras({ afterTool: async (result) => {
      results.push(result);
      return { message: null };
    } }));
    await fake.finished("subagent", input);
    return results[0];
  };

  test("a subagent's tool_result says no delegated run finished, even with async: false", async () => {
    // pi-subagents 0.52.1 may still run it in the background (forceTopLevelAsync), and a timed-out child may leave isError unset.
    const result = await resultOf({ tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }], async: false });
    expect(wireOf(result)).toEqual({
      kind: "tool-result",
      role: null,
      tool: "subagent",
      effects: [{ kind: "delegate", agent: "a" }, { kind: "delegate", agent: "b" }],
      ok: true,
      callId: "1",
      delegatedAgentRuns: [{ finished: false }, { finished: false }],
    });
    // Without async: false the call runs in the background by default, so its delegations' finishes go unreported.
    const unsaid = await resultOf({ agent: "a", task: "x" });
    expect(unsaid?.delegatedAgentRuns).toEqual([{ finished: false }]);
    expect(unsaid?.effects.every((effect) => effect.kind === "delegate" && effect.finishUnreported === true)).toBe(true);
  });

  test("an async subagent's tool_result says none did", async () => {
    const result = await resultOf({ tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }], async: true });
    expect(result?.delegatedAgentRuns).toEqual([{ finished: false }, { finished: false }]);
    expect(result?.effects.every((effect) => effect.kind === "delegate" && effect.finishUnreported === true)).toBe(true);
  });

  test("an afterTool that fails tells the agent so, never silently", async () => {
    const fake = await started(withExtras({ afterTool: async () => { throw new Error("boom"); } }));
    expect(await fake.finished("bash", { command: "ls" })).toEqual({
      content: [{ type: "text", text: "done" }, { type: "text", text: "bounded could not check protected files after this call: boom. Check them against version control." }],
      isError: true,
    });
  });

  test("an afterTool that fails is recorded through refuse as well as told", async () => {
    const recorded: AdapterRefusal[] = [];
    const fake = await started(withExtras({ afterTool: async () => { throw new Error("boom"); }, refuse: async (refusal) => void recorded.push(refusal) }));
    await fake.finished("bash", { command: "ls" });
    expect(recorded).toEqual([
      {
        hostToolName: "bash",
        reason: "bounded could not check protected files after this call: boom. Check them against version control.",
        redirect: "Check the protected files against version control",
        role: null,
        input: { command: "ls" },
      },
    ]);
  });

  test("a call the adapter blocks itself is recorded through refuse, and still blocked", async () => {
    const recorded: AdapterRefusal[] = [];
    const fake = await started(withExtras({ refuse: async (refusal) => void recorded.push(refusal) }));
    const result = await fake.call("read", { path: "../outside.txt" });
    expect(result).toMatchObject({ block: true });
    const [reason, redirect] = (result as { reason: string }).reason.split("\n");
    expect<unknown>(recorded).toEqual([{ hostToolName: "read", reason, redirect, role: null, input: { path: "../outside.txt" } }]);
  });

  test("a recording that hangs or fails never delays or changes the block", async () => {
    const hanging = await started(withExtras({ refuse: () => never() }), { deadlineMs: 50 });
    expect(await hanging.call("read", { path: "../outside.txt" })).toMatchObject({ block: true });
    const failing = await started(withExtras({ refuse: async () => { throw new Error("no log"); } }));
    expect(await failing.call("read", { path: "../outside.txt" })).toMatchObject({ block: true });
  });
});

describe("piExtension — fails closed", () => {
  const blocked = (result: unknown, ...parts: string[]) => {
    expect(result).toMatchObject({ block: true });
    const reason = (result as { reason: string }).reason;
    expect(reason.split("\n")).toHaveLength(2);
    for (const part of parts) expect(reason).toContain(part);
  };

  test("a call it cannot translate is blocked, saying why", async () => {
    const fake = await started(loads(noGenerated));
    blocked(await fake.call("read", { path: "../outside.txt" }), "pi's read call", "outside the project");
  });

  test("a composition that fails at session start blocks every call", async () => {
    const fake = await started(async () => {
      throw new Error("bounded.config.ts selects pack 'x', which is not installed");
    });
    blocked(await fake.call("read", { path: "a.ts" }), "bounded could not start", "which is not installed");
  });

  test("a tool call before any session start is blocked", async () => {
    const fake = fakePi();
    piExtension({ projectRoot: project, load: loads(noGenerated) })(fake.pi);
    blocked(await fake.call("read", { path: "a.ts" }), "before the session started");
  });

  test("a decide that throws or returns something that is not a verdict blocks", async () => {
    const throwing: ProjectJudgeForPi = async () => {
      throw new Error("guard exploded");
    };
    blocked(await (await started(loads(throwing))).call("read", { path: "a.ts" }), "guard exploded");
    blocked(await (await started(loads(async () => ({ kind: "maybe" }) as unknown as Verdict))).call("read", { path: "a.ts" }), "not a verdict");
  });

  test("an event or context it cannot read blocks instead of throwing", async () => {
    const fake = await started(loads(noGenerated));
    blocked(await fake.call("read", { path: "a.ts" }, {}), "cwd");
    blocked(await fake.call("read", { path: "a.ts" }, null), "cwd");
    const [result] = await Promise.all(fake.handlers.get("tool_call")?.map((handler) => handler(null, { cwd: project })) ?? []);
    blocked(result, "tool call");
  });

  test("an empty or relative cwd in pi's context blocks", async () => {
    const fake = await started(loads(noGenerated));
    blocked(await fake.call("read", { path: "a.ts" }, { cwd: "" }), "cwd");
    blocked(await fake.call("read", { path: "a.ts" }, { cwd: "relative/dir" }), "cwd");
  });

  test("a refusing decide is never bypassed by a later call", async () => {
    const refuseAll: ProjectJudgeForPi = async () => Verdict.refuse("nothing runs here", "Ask the maintainer");
    const fake = await started(loads(refuseAll));
    for (const [tool, input] of [["bash", { command: "ls" }], ["web_search", { query: "x" }], ["mystery", {}]] as const) {
      expect(await fake.call(tool, input)).toEqual({ block: true, reason: "nothing runs here\nAsk the maintainer" });
    }
  });

  test("a decide that never settles blocks at the deadline instead of hanging pi", async () => {
    const fake = await started(loads(() => never()), { deadlineMs: 50 });
    blocked(await fake.call("read", { path: "a.ts" }), "did not decide within 50 ms");
  });

  test("a composition that never settles neither hangs the session start nor lets calls through", async () => {
    const fake = await started(() => never(), { composeDeadlineMs: 50 });
    blocked(await fake.call("read", { path: "a.ts" }), "bounded could not start", "within 50 ms");
  });
});

describe("piExtension — freezing and deadlines", () => {
  test("freezes the input before translating, everything inside it, frozen parents included", async () => {
    const edit = { oldText: "a", newText: "b" };
    const input = { path: "a.ts", edits: Object.freeze([edit]) };
    let frozenWhenDecided = false;
    const fake = await started(loads(async () => {
      frozenWhenDecided = Object.isFrozen(input) && Object.isFrozen(edit);
      return Verdict.allow;
    }));
    expect(await fake.call("edit", input)).toBeUndefined();
    expect(frozenWhenDecided).toBe(true);
    expect(Object.isFrozen(edit)).toBe(true);
  });

  test("a composition that times out is retried after a back-off, not on every call", async () => {
    let count = 0;
    const fake = await started(async () => {
      count += 1;
      return count === 1 ? never() : noGenerated;
    }, { composeDeadlineMs: 50, composeBackoffMs: 200 });
    const first = await fake.call("read", { path: "a.ts" });
    expect(first).toMatchObject({ block: true });
    expect((first as { reason: string }).reason).toContain("within 50 ms");
    const during = await fake.call("read", { path: "a.ts" });
    expect((during as { reason: string }).reason).toContain("timed out");
    expect((during as { reason: string }).reason).toMatch(/retries in 0\.\d s/);
    expect(count).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await fake.call("read", { path: "a.ts" })).toBeUndefined();
    expect(count).toBe(2);
  });

  test("composing has its own deadline, longer than each decision's", async () => {
    const slow: LoadJudge = () => new Promise((resolve) => setTimeout(() => resolve(noGenerated), 100));
    const fake = await started(slow, { deadlineMs: 50, composeDeadlineMs: 1000 });
    expect(await fake.call("read", { path: "a.ts" })).toBeUndefined();
  });

  test("bounded(root, options) passes its deadlines to the extension", async () => {
    // A configuration that never finishes loading: only the compose deadline ends the wait.
    const hanging = mkdtempSync(join(tmpdir(), "bounded-pi-hanging-"));
    writeFileSync(join(hanging, "bounded.config.ts"), "await new Promise(() => {});\nexport default {};\n");
    const fake = fakePi();
    bounded(hanging, { composeDeadlineMs: 50, deadlineMs: 50 })(fake.pi);
    await fake.start();
    const result = await fake.call("read", { path: "a.ts" }, { cwd: hanging });
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain("within 50 ms");
  });
});
