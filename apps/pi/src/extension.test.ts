import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Verdict } from "bounded/domain";
import type { ToolUse } from "./event.ts";
import { type Decide, type ExtensionOptions, type Load, type Pi, type PiHandler, piExtension } from "./extension.ts";
import { bounded } from "./index.ts";

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
  return { pi, handlers, start, call };
}

// The decide a composed project would give: refuse writes under generated/.
const seen: ToolUse[] = [];
const noGenerated: Decide = async (event) => {
  seen.push(event);
  return event.effects.some((effect) => effect.kind === "write" && effect.path.startsWith("generated/"))
    ? Verdict.refuse("generated/ is written by the generator", "Change the generator's input instead")
    : Verdict.allow;
};
const loads = (decide: Decide): Load => async () => decide;
const never = <T>(): Promise<T> => new Promise<T>(() => {});

async function started(load: Load, deadlines: Pick<ExtensionOptions, "deadlineMs" | "composeDeadlineMs" | "composeBackoffMs"> = {}) {
  const fake = fakePi();
  piExtension({ root: project, load, home: "/home/agent", ...deadlines })(fake.pi);
  await fake.start();
  return fake;
}

describe("piExtension — end to end through a fake pi", () => {
  test("registers for session_start and tool_call only", () => {
    const fake = fakePi();
    piExtension({ root: project, load: loads(noGenerated) })(fake.pi);
    expect([...fake.handlers.keys()].sort()).toEqual(["session_start", "tool_call"]);
  });

  test("an allowed call returns undefined, so pi runs it", async () => {
    const fake = await started(loads(noGenerated));
    expect(await fake.call("read", { path: "generated/api.ts" })).toBeUndefined();
    expect<unknown>(seen.at(-1)).toEqual({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "generated/api.ts" }] });
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
    expect<unknown>(seen.at(-1)).toEqual({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command: "ls", cwd: "generated" }] });
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
    piExtension({ root: project, load: loads(noGenerated) })(fake.pi);
    blocked(await fake.call("read", { path: "a.ts" }), "before the session started");
  });

  test("a decide that throws or returns something that is not a verdict blocks", async () => {
    const throwing: Decide = async () => {
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
    const refuseAll: Decide = async () => Verdict.refuse("nothing runs here", "Ask the maintainer");
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
    const slow: Load = () => new Promise((resolve) => setTimeout(() => resolve(noGenerated), 100));
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
