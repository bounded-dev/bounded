import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ShellCommandReadingJSON, type ToolResult, Verdict } from "bounded/domain";
import { ReadShellCommandHandler, type ShellCommandReader } from "bounded-shell-command-reader/application";
import type { ReadShellCommand } from "bounded-shell-command-reader/shell-command-reading";
import type { ToolUse } from "./event.ts";
import { type AdapterRefusal, type ProjectJudgeForPi, type ExtensionOptions, type LoadJudge, type Pi, type PiHandler, piExtension } from "./extension.ts";
import { bounded } from "./index.ts";

/** A value's wire form: its JSON, parsed. */
const wireOf = (value: unknown): unknown => JSON.parse(JSON.stringify(value) ?? "null");

const project = mkdtempSync(join(tmpdir(), "bounded-pi-extension-"));
mkdirSync(join(project, "generated"), { recursive: true });
writeFileSync(join(project, "generated", "api.ts"), "");

/** A handler on pi's event bus, as the stand-in calls it. */
type BusHandler = (data: unknown) => unknown;

/**
 * A stand-in for pi: records handlers, and emits events to them as pi would,
 * awaiting each. With `bus` (the default), it has pi's shared event bus
 * (`pi.events`): `on` returns an unsubscribe, and `publish` awaits handlers.
 */
function fakePi({ bus = true }: { readonly bus?: boolean } = {}) {
  const handlers = new Map<string, PiHandler[]>();
  const subscribers = new Map<string, BusHandler[]>();
  const events = {
    on(channel: string, handler: BusHandler) {
      subscribers.set(channel, [...(subscribers.get(channel) ?? []), handler]);
      return () => subscribers.set(channel, (subscribers.get(channel) ?? []).filter((given) => given !== handler));
    },
  };
  const pi: Pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    ...(bus ? { events } : {}),
  };
  const emit = (event: string, payload: unknown, context: unknown = { cwd: project }) => Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, context)));
  const start = () => emit("session_start", { type: "session_start", reason: "startup" });
  const call = async (toolName: string, input: unknown, context?: unknown) => (await emit("tool_call", { type: "tool_call", toolCallId: "1", toolName, input }, context))[0];
  const callAs = async (toolCallId: string, toolName: string, input: unknown) => (await emit("tool_call", { type: "tool_call", toolCallId, toolName, input }))[0];
  const finished = async (toolName: string, input: unknown, isError = false) =>
    (await emit("tool_result", { type: "tool_result", toolCallId: "1", toolName, input, content: [{ type: "text", text: "done" }], isError }))[0];
  /** A tool_result event as given, such as a fixture. */
  const resulted = async (event: unknown) => (await emit("tool_result", event))[0];
  const publish = async (channel: string, payload: unknown): Promise<void> => {
    await Promise.all((subscribers.get(channel) ?? []).map((handler) => handler(payload)));
  };
  return { pi, handlers, subscribers, start, call, callAs, finished, resulted, publish };
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

/** The reading the stand-in reader gives every command: one running tool-a from the project root. */
const READ: ShellCommandReadingJSON = { outcome: "read", programs: [{ name: { kind: "literal", text: "tool-a" }, arguments: [], workingDirectory: "." }], fileEffects: [], unresolved: [] };
/** What the stand-in reader was asked to read, in order. */
const reads: unknown[] = [];
const readShellCommand: ReadShellCommand = {
  prepare: async () => {},
  read: async (input) => {
    reads.push(input);
    return READ;
  },
};

async function started(load: LoadJudge, deadlines: Pick<ExtensionOptions, "deadlineMs" | "composeDeadlineMs" | "composeBackoffMs"> = {}, reader: ReadShellCommand = readShellCommand) {
  const fake = fakePi();
  piExtension({ projectRoot: project, load, readShellCommand: reader, home: "/home/agent", ...deadlines })(fake.pi);
  await fake.start();
  return fake;
}

describe("piExtension — end to end through a fake pi", () => {
  test("registers for session_start, tool_call and tool_result only", () => {
    const fake = fakePi();
    piExtension({ projectRoot: project, load: loads(noGenerated), readShellCommand })(fake.pi);
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
    expect(wireOf(seen.at(-1))).toEqual({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command: "ls", cwd: "generated", reading: READ }], callId: "1" });
  });

  test("a shell call's tool use carries the reading the reader gave, read from the project's root and the session's directory", async () => {
    const fake = await started(loads(noGenerated));
    reads.length = 0;
    expect(await fake.call("bash", { command: "ls" }, { cwd: join(project, "generated") })).toBeUndefined();
    expect(reads).toEqual([{ projectRoot: project, command: "ls", cwd: "generated" }]);
    const [effect] = seen.at(-1)?.effects ?? [];
    expect(effect?.kind === "execute" && effect.reading.toJSON()).toEqual(READ);
  });

  test("the reader's preparation starts at each session start, without holding the session up", async () => {
    let prepared = 0;
    const counting: ReadShellCommand = {
      prepare: () => {
        prepared++;
        return never();
      },
      read: async () => READ,
    };
    const fake = await started(loads(noGenerated), {}, counting);
    expect(prepared).toBe(1);
    await fake.start();
    expect(prepared).toBe(2);
  });

  test("a shell call made while the reader still prepares waits for it and is allowed when preparing ends within the deadline", async () => {
    let prepared = false;
    const loading: ShellCommandReader = {
      prepare: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            prepared = true;
            resolve();
          }, 100),
        ),
      read: async () => {
        if (!prepared) throw new Error("read before the grammar loaded");
        return READ;
      },
    };
    const fake = await started(loads(noGenerated), { deadlineMs: 1000 }, new ReadShellCommandHandler(loading, { readWithinMs: 50 }));
    expect(await fake.call("bash", { command: "ls" })).toBeUndefined();
    const [effect] = seen.at(-1)?.effects ?? [];
    expect(effect?.kind === "execute" && effect.reading.toJSON()).toEqual(READ);
  });

  test("reading and deciding share the decision's deadline", async () => {
    let decided = false;
    const hanging: ReadShellCommand = { prepare: async () => {}, read: () => never() };
    const fake = await started(
      loads(async () => {
        decided = true;
        return Verdict.allow;
      }),
      { deadlineMs: 50 },
      hanging,
    );
    const result = await fake.call("bash", { command: "ls" });
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain("bounded did not decide within 50 ms on pi's bash call");
    expect(decided).toBe(false);
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
    expect(wireOf(results)).toEqual([{ kind: "tool-result", role: null, tool: "shell", effects: [{ kind: "execute", command: "./regenerate.sh", cwd: ".", reading: READ }], ok: true, callId: "1" }]);
  });

  test("a finished shell call reaches afterTool with its execute effect's reading", async () => {
    const results: ToolResult[] = [];
    const fake = await started(withExtras({ afterTool: async (result) => {
      results.push(result);
      return { message: null };
    } }));
    reads.length = 0;
    expect(await fake.finished("bash", { command: "./regenerate.sh" })).toBeUndefined();
    expect(reads).toEqual([{ projectRoot: project, command: "./regenerate.sh", cwd: "." }]);
    const [effect] = results[0]?.effects ?? [];
    expect(effect?.kind === "execute" && effect.reading.toJSON()).toEqual(READ);
  });

  test("a finished shell call whose re-read never settles is told, at the decision's deadline", async () => {
    let checked = false;
    const hanging: ReadShellCommand = { prepare: async () => {}, read: () => never() };
    const fake = await started(
      withExtras({
        afterTool: async () => {
          checked = true;
          return { message: null };
        },
      }),
      { deadlineMs: 50 },
      hanging,
    );
    const result = (await fake.finished("bash", { command: "ls" })) as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content.at(-1)?.text).toContain("bounded could not check protected files after this call: no answer within 50 ms");
    expect(checked).toBe(false);
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
    piExtension({ projectRoot: project, load: loads(noGenerated), readShellCommand })(fake.pi);
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

/** A fixture's fields, read without trusting them. */
type Fields = Record<string, unknown>;
/** pi-subagents' completion payload, as a fixture gives it. */
type Completion = Fields & { results: Fields[] };
/** A subagent tool_result event, as a fixture gives it. */
type ResultEvent = Fields & { toolCallId: string; input: Fields; details: Fields & { results: Fields[] } };

const PI_SUBAGENTS = join(import.meta.dir, "test", "fixtures", "pi-subagents");
/** A pi-subagents fixture (derived from source, not captured; ADR 2026-028), read afresh, without its `_source` citation. */
function fixture<T extends Fields>(name: string): T {
  const read = JSON.parse(readFileSync(join(PI_SUBAGENTS, name), "utf8")) as T;
  delete read._source;
  return read;
}
const R = "5b1f0c6e-2d4a-4c8e-9f3b-7a1d2e3c4b5a";
const C = "9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4";
const COMPLETE = "subagent:async-complete";
const launch = (): ResultEvent => fixture("async-launch.tool-result.json");
const completion = (name = "async-complete.json"): Completion => fixture(name);
const sync = (name = "sync-completed.tool-result.json"): ResultEvent => fixture(name);
const NEVER = { finished: false, finishNeverReported: true };
const UNTIED_REDIRECT = "Start a new run of the agent instead: subagent({ agent, task }) with the agent and the task you meant to resume";

/** A started session over a fake pi with an event bus (unless `bus` is false), recording what reaches decide, afterTool and recordAgentRunFinish. */
async function finishSession({ bus = true, recordAgentRunFinish, load }: { readonly bus?: boolean; readonly recordAgentRunFinish?: (finish: unknown) => Promise<unknown>; readonly load?: (decide: ProjectJudgeForPi) => LoadJudge } = {}) {
  const fake = fakePi({ bus });
  const decided: ToolUse[] = [];
  const results: ToolResult[] = [];
  const finishes: unknown[] = [];
  const decide: ProjectJudgeForPi = Object.assign(
    async (event: ToolUse) => {
      decided.push(event);
      return Verdict.allow;
    },
    {
      afterTool: async (result: ToolResult) => {
        results.push(result);
        return { message: null };
      },
      recordAgentRunFinish: recordAgentRunFinish ?? (async (finish: unknown) => void finishes.push(finish)),
    },
  );
  piExtension({ projectRoot: project, load: (load ?? loads)(decide), readShellCommand, home: "/home/agent" })(fake.pi);
  await fake.start();
  /** The delegatedAgentRuns of the result `event` gives afterTool, in wire form. */
  const runsOf = async (event: unknown): Promise<unknown> => {
    await fake.resulted(event);
    return wireOf(results.at(-1)?.delegatedAgentRuns);
  };
  /** The effects decide saw for a resume call with these fields, in wire form; or the block. */
  const resume = async (fields: Fields): Promise<unknown> => {
    const before = decided.length;
    const answer = await fake.callAs("call-resume", "subagent", { action: "resume", message: "go on", ...fields });
    return answer === undefined && decided.length > before ? wireOf(decided.at(-1)?.effects) : answer;
  };
  return { ...fake, decided, results, finishes, runsOf, resume };
}

/** A block whose reason says bounded cannot tell which agent a resume runs, and whose redirect starts a new run. */
function blockedAsUnseen(answer: unknown): void {
  expect(answer).toMatchObject({ block: true });
  const lines = (answer as { reason: string }).reason.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("cannot tell which agent");
  expect(lines[1]).toBe(UNTIED_REDIRECT);
}

const TIED = [{ kind: "delegate", agent: "plan-reviewer", finishUnreported: true }, { kind: "invoke", name: "subagent.resume" }];

describe("piExtension — a delegated run's finish (ADR 2026-028)", () => {
  test("subscribes to subagent:async-complete on pi's event bus once, when it loads", async () => {
    const fake = fakePi();
    piExtension({ projectRoot: project, load: loads(noGenerated), readShellCommand })(fake.pi);
    expect(fake.subscribers.get(COMPLETE)).toHaveLength(1);
    await fake.start();
    await fake.start();
    expect(fake.subscribers.get(COMPLETE)).toHaveLength(1);
  });

  test("an async launch's result gives its run id, its finish reported later, and its delegation is not finishUnreported", async () => {
    const session = await finishSession();
    await session.resulted(launch());
    const result = wireOf(session.results.at(-1)) as Fields;
    expect(result.delegatedAgentRuns).toEqual([{ finished: false, agentRunId: R, finishReportedLater: true }]);
    expect(result.effects).toEqual([{ kind: "delegate", agent: "plan-reviewer" }]);
    expect(result.ok).toBe(true);
    expect(result.callId).toBe("call-review-1");
  });

  test("a synchronous result whose one run ran to its end is finished, as the agent pi-subagents ran", async () => {
    const session = await finishSession();
    expect(await session.runsOf(sync())).toEqual([{ finished: true, resolvedAgent: "plan-reviewer" }]);
  });

  test("a synchronous result whose run stopped early is not finished", async () => {
    const session = await finishSession();
    const changed = (change: (child: Fields) => void): ResultEvent => {
      const event = sync();
      const [child] = event.details.results;
      if (child !== undefined) change(child);
      return event;
    };
    const stoppedEarly = [
      sync("sync-timed-out.tool-result.json"),
      sync("sync-interrupted.tool-result.json"),
      changed((child) => {
        child.detached = true;
      }),
      changed((child) => {
        child.exitCode = 1;
      }),
      changed((child) => {
        child.stopped = true;
      }),
      changed((child) => {
        child.turnBudgetExceeded = true;
      }),
    ];
    for (const event of stoppedEarly) expect(await session.runsOf(event)).toEqual([{ finished: false }]);
  });

  test("a result bounded cannot pair with one run, or whose details it cannot read or trust, says the finish is never reported", async () => {
    const session = await finishSession();
    const twoTasks = sync();
    twoTasks.input = { tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }], async: false };
    expect(await session.runsOf(twoTasks)).toEqual([NEVER, NEVER]);
    expect(wireOf(session.results.at(-1)?.effects)).toEqual([{ kind: "delegate", agent: "a" }, { kind: "delegate", agent: "b" }]);

    const variants: ResultEvent[] = [];
    const fromSync = (change: (event: ResultEvent) => void) => {
      const event = sync();
      change(event);
      variants.push(event);
    };
    const fromLaunch = (change: (event: ResultEvent) => void) => {
      const event = launch();
      change(event);
      variants.push(event);
    };
    fromSync((event) => {
      delete (event as Fields).details;
    });
    fromSync((event) => {
      event.details.results = "x" as unknown as Fields[];
    });
    fromSync((event) => {
      event.details.results = [...event.details.results, ...event.details.results];
    });
    for (const asyncId of ["", 3, "r".repeat(257)]) {
      fromLaunch((event) => {
        event.details.asyncId = asyncId;
      });
    }
    fromLaunch((event) => {
      event.details.mode = "single";
    });
    fromLaunch((event) => {
      event.details.toolCallId = "other-call";
    });
    fromLaunch((event) => {
      delete event.details.toolCallId;
    });
    fromLaunch((event) => {
      event.details.results = [{ agent: "plan-reviewer", exitCode: 0 }];
    });
    for (const event of variants) expect(await session.runsOf(event)).toEqual([NEVER]);
    expect(session.results).toHaveLength(variants.length + 1);
    expect(session.results.every((result) => result.effects.every((effect) => effect.kind !== "delegate" || effect.finishUnreported !== true))).toBe(true);
  });

  test("on a pi with no event bus, an async launch says its finish is never reported, and a synchronous result still counts", async () => {
    const session = await finishSession({ bus: false });
    expect(await session.runsOf(launch())).toEqual([NEVER]);
    expect(await session.runsOf(sync())).toEqual([{ finished: true, resolvedAgent: "plan-reviewer" }]);
  });

  test("pi-subagents' async completion reaches recordAgentRunFinish as the run's finish", async () => {
    const session = await finishSession();
    await session.publish(COMPLETE, completion());
    expect(session.finishes).toEqual([{ kind: "agent-run-finished", role: null, agent: "plan-reviewer", agentRunId: R, ranToEnd: true }]);
  });

  test("a completion that says its run failed, stopped or paused, or whose one child did not complete, has ranToEnd false", async () => {
    const session = await finishSession();
    const changed = (change: (payload: Completion, child: Fields) => void): Completion => {
      const payload = completion();
      const [child] = payload.results;
      if (child !== undefined) change(payload, child);
      return payload;
    };
    const notToTheEnd = [
      completion("async-complete-failed.json"),
      completion("async-complete-stopped.json"),
      changed((payload) => {
        payload.state = "paused";
      }),
      changed((_, child) => {
        child.success = false;
      }),
      changed((_, child) => {
        child.status = "stopped";
      }),
      changed((_, child) => {
        delete child.status;
      }),
      changed((_, child) => {
        child.detached = true;
      }),
      changed((payload) => {
        delete payload.state;
      }),
    ];
    for (const payload of notToTheEnd) {
      const before = session.finishes.length;
      await session.publish(COMPLETE, payload);
      expect(session.finishes.length).toBe(before + 1);
      expect(session.finishes.at(-1)).toEqual({ kind: "agent-run-finished", role: null, agent: "plan-reviewer", agentRunId: R, ranToEnd: false });
    }
  });

  test("a completion naming no single child sends nothing; one whose run id or child's agent cannot be read is passed on with null", async () => {
    const session = await finishSession();
    const none = completion();
    none.results = [];
    const two = completion();
    two.results = [...two.results, ...two.results];
    const missing = completion();
    delete (missing as Fields).results;
    for (const payload of [none, two, missing]) await session.publish(COMPLETE, payload);
    expect(session.finishes).toEqual([]);
    const noRunId = completion();
    delete noRunId.runId;
    await session.publish(COMPLETE, noRunId);
    expect(session.finishes.at(-1)).toEqual({ kind: "agent-run-finished", role: null, agent: "plan-reviewer", agentRunId: null, ranToEnd: true });
    const noAgent = completion();
    delete noAgent.results[0]?.agent;
    await session.publish(COMPLETE, noAgent);
    expect(session.finishes.at(-1)).toEqual({ kind: "agent-run-finished", role: null, agent: null, agentRunId: R, ranToEnd: true });
  });

  test("a completion is read when it arrives: changing the payload afterwards does not change what is recorded", async () => {
    let release: () => void = () => {};
    const session = await finishSession({
      load: (decide) => () =>
        new Promise<ProjectJudgeForPi>((resolve) => {
          release = () => resolve(decide);
        }),
    });
    const payload = completion();
    const published = session.publish(COMPLETE, payload);
    const [child] = payload.results;
    if (child !== undefined) child.agent = "scout";
    payload.state = "failed";
    release();
    await published;
    expect(session.finishes).toEqual([{ kind: "agent-run-finished", role: null, agent: "plan-reviewer", agentRunId: R, ranToEnd: true }]);
  });

  test("only a started, composed session records a completion, and a failing record never escapes", async () => {
    const recordedEarly: unknown[] = [];
    const recordingJudge = (into: unknown[]): ProjectJudgeForPi => Object.assign(async () => Verdict.allow, { recordAgentRunFinish: async (finish: unknown) => void into.push(finish) });
    const unstarted = fakePi();
    piExtension({ projectRoot: project, load: loads(recordingJudge(recordedEarly)), readShellCommand })(unstarted.pi);
    await unstarted.publish(COMPLETE, completion());
    expect(recordedEarly).toEqual([]);

    const failing = fakePi();
    piExtension({ projectRoot: project, load: async () => { throw new Error("bounded.config.ts cannot be loaded"); }, readShellCommand })(failing.pi);
    await failing.start();
    await failing.publish(COMPLETE, completion());
    expect(await failing.call("read", { path: "a.ts" })).toMatchObject({ block: true });

    let attempts = 0;
    const recorded: unknown[] = [];
    const throwing = await finishSession({
      recordAgentRunFinish: (finish) => {
        attempts += 1;
        if (attempts === 1) throw new Error("log unwritable");
        if (attempts === 2) return Promise.reject(new Error("log unwritable"));
        recorded.push(finish);
        return Promise.resolve();
      },
    });
    await throwing.publish(COMPLETE, completion());
    await throwing.publish(COMPLETE, completion());
    await throwing.publish(COMPLETE, completion());
    expect(attempts).toBe(3);
    expect(recorded).toHaveLength(1);

    const composed = await finishSession();
    await composed.publish(COMPLETE, completion());
    expect(composed.finishes).toHaveLength(1);
  });

  test("a resume of a run bounded launched and saw finish as the same agent is judged as a delegation to that agent", async () => {
    const session = await finishSession();
    await session.resulted(launch());
    await session.publish(COMPLETE, completion());
    expect(await session.resume({ id: R })).toEqual(TIED);
    expect(await session.resume({ id: "call-review-1" })).toEqual(TIED);
    expect(await session.resume({ runId: R })).toEqual(TIED);
    expect(await session.resume({ id: R, index: 0 })).toEqual(TIED);

    const stopped = await finishSession();
    await stopped.resulted(launch());
    await stopped.publish(COMPLETE, completion("async-complete-stopped.json"));
    expect(await stopped.resume({ id: R })).toEqual(TIED);

    const synchronous = await finishSession();
    await synchronous.resulted(sync());
    expect(await synchronous.resume({ id: "call-review-2" })).toEqual(TIED);
  });

  test("a tied resume's result says its finish is never reported", async () => {
    const session = await finishSession();
    await session.resulted(launch());
    await session.publish(COMPLETE, completion());
    expect(await session.resume({ id: R })).toEqual(TIED);
    const resumedRunId = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const resumed = launch();
    resumed.toolCallId = "call-resume";
    resumed.input = { action: "resume", id: R, message: "go on" };
    resumed.details = { ...resumed.details, runId: resumedRunId, asyncId: resumedRunId, toolCallId: "call-resume" };
    expect(await session.runsOf(resumed)).toEqual([NEVER]);
    // A resume's result never fills what ties a later resume, even once its run's completion arrives.
    const resumedFinish = completion();
    resumedFinish.id = resumedRunId;
    resumedFinish.runId = resumedRunId;
    await session.publish(COMPLETE, resumedFinish);
    blockedAsUnseen(await session.resume({ id: resumedRunId }));
  });

  test("a resume bounded cannot tie to an agent is blocked as unseen, with a redirect to start a new run", async () => {
    const session = await finishSession();
    await session.resulted(launch());
    await session.publish(COMPLETE, completion());
    for (const fields of [{ id: "never-seen" }, { id: R.slice(0, 8) }, { id: R, index: 1 }, { dir: "runs/r1" }, {}]) blockedAsUnseen(await session.resume(fields));

    const launchedOnly = await finishSession();
    await launchedOnly.resulted(launch());
    blockedAsUnseen(await launchedOnly.resume({ id: R }));

    // A fresh load stands for a pi restart: what tied a run is in memory only.
    const restarted = await finishSession();
    blockedAsUnseen(await restarted.resume({ id: R }));

    // An unseen run ties nothing.
    const unseen = await finishSession();
    await unseen.publish(COMPLETE, completion());
    for (const id of [R, "call-review-1", C]) blockedAsUnseen(await unseen.resume({ id }));

    // A different agent ties nothing.
    const otherAgent = await finishSession();
    await otherAgent.resulted(launch());
    const scout = completion();
    const [scoutChild] = scout.results;
    if (scoutChild !== undefined) scoutChild.agent = "scout";
    await otherAgent.publish(COMPLETE, scout);
    blockedAsUnseen(await otherAgent.resume({ id: R }));

    // A conflicting second completion removes the tie, and an agreeing third does not restore it.
    const conflicting = await finishSession();
    await conflicting.resulted(launch());
    await conflicting.publish(COMPLETE, completion());
    expect(await conflicting.resume({ id: R })).toEqual(TIED);
    await conflicting.publish(COMPLETE, scout);
    blockedAsUnseen(await conflicting.resume({ id: R }));
    blockedAsUnseen(await conflicting.resume({ id: "call-review-1" }));
    await conflicting.publish(COMPLETE, completion());
    blockedAsUnseen(await conflicting.resume({ id: R }));

    // Never overwritten: a second launch reusing the run id leaves the tie as it was.
    const reused = await finishSession();
    await reused.resulted(launch());
    await reused.publish(COMPLETE, completion());
    const builder = launch();
    builder.toolCallId = "call-build-1";
    builder.input = { agent: "builder", task: "Build it" };
    builder.details = { ...builder.details, toolCallId: "call-build-1" };
    await reused.resulted(builder);
    expect(await reused.resume({ id: R })).toEqual(TIED);
  });
});
