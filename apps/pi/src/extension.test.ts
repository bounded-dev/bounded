import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Verdict } from "bounded/domain";
import type { ToolUse } from "./event.ts";
import { type Decide, type Pi, type PiHandler, piExtension } from "./extension.ts";

const project = mkdtempSync(join(tmpdir(), "bounded-pi-extension-"));
mkdirSync(join(project, "generated"), { recursive: true });
writeFileSync(join(project, "generated", "api.ts"), "");

/** A stand-in for pi: records handlers, and emits events to them as pi would. */
function fakePi() {
  const handlers = new Map<string, PiHandler[]>();
  const pi: Pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  const emit = (event: string, payload: unknown, context: unknown = { cwd: project }) => (handlers.get(event) ?? []).map((handler) => handler(payload, context));
  const start = () => emit("session_start", { type: "session_start", reason: "startup" });
  const call = (toolName: string, input: unknown, context?: unknown) => emit("tool_call", { type: "tool_call", toolCallId: "1", toolName, input }, context)[0];
  return { pi, handlers, start, call };
}

// The decide a composed project would give: refuse writes under generated/.
const seen: ToolUse[] = [];
const noGenerated: Decide = (event) => {
  seen.push(event);
  return event.effects.some((effect) => effect.kind === "write" && effect.path.startsWith("generated/"))
    ? Verdict.refuse("generated/ is written by the generator", "Change the generator's input instead")
    : Verdict.allow;
};

function started(load: () => Decide) {
  const fake = fakePi();
  piExtension({ root: project, load, home: "/home/agent" })(fake.pi);
  fake.start();
  return fake;
}

describe("piExtension — end to end through a fake pi", () => {
  test("registers for session_start and tool_call only", () => {
    const fake = fakePi();
    piExtension({ root: project, load: () => noGenerated })(fake.pi);
    expect([...fake.handlers.keys()].sort()).toEqual(["session_start", "tool_call"]);
  });

  test("an allowed call returns undefined, so pi runs it", () => {
    const fake = started(() => noGenerated);
    expect(fake.call("read", { path: "generated/api.ts" })).toBeUndefined();
    expect<unknown>(seen.at(-1)).toEqual({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "generated/api.ts" }] });
  });

  test("a refused call blocks, with the reason and the redirect on separate lines", () => {
    const fake = started(() => noGenerated);
    expect(fake.call("edit", { path: join(project, "generated", "api.ts"), edits: [] })).toEqual({
      block: true,
      reason: "generated/ is written by the generator\nChange the generator's input instead",
    });
  });

  test("the session's cwd from pi's context is where relative paths start", () => {
    const fake = started(() => noGenerated);
    expect(fake.call("write", { path: "api.ts" }, { cwd: join(project, "generated") })).toMatchObject({ block: true });
  });

  test("composes once per session start, not per call", () => {
    let loads = 0;
    const fake = started(() => {
      loads += 1;
      return noGenerated;
    });
    fake.call("read", { path: "a.ts" });
    fake.call("read", { path: "b.ts" });
    expect(loads).toBe(1);
    fake.start();
    expect(loads).toBe(2);
  });
});

describe("piExtension — fails closed", () => {
  const blocked = (result: unknown, ...parts: string[]) => {
    expect(result).toMatchObject({ block: true });
    const reason = (result as { reason: string }).reason;
    expect(reason.split("\n")).toHaveLength(2);
    for (const part of parts) expect(reason).toContain(part);
  };

  test("a call it cannot translate is blocked, saying why", () => {
    const fake = started(() => noGenerated);
    blocked(fake.call("read", { path: "../outside.txt" }), "pi's read call", "outside the project");
  });

  test("a composition that fails at session start blocks every call", () => {
    const fake = started(() => {
      throw new Error("bounded.config.ts selects pack 'x', which is not installed");
    });
    blocked(fake.call("read", { path: "a.ts" }), "bounded could not start", "which is not installed");
  });

  test("a tool call before any session start is blocked", () => {
    const fake = fakePi();
    piExtension({ root: project, load: () => noGenerated })(fake.pi);
    blocked(fake.call("read", { path: "a.ts" }), "before the session started");
  });

  test("a decide that throws or returns something that is not a verdict blocks", () => {
    blocked(started(() => () => { throw new Error("guard exploded"); }).call("read", { path: "a.ts" }), "guard exploded");
    blocked(started(() => () => ({ kind: "maybe" }) as unknown as Verdict).call("read", { path: "a.ts" }), "not a verdict");
  });

  test("an event or context it cannot read blocks instead of throwing", () => {
    const fake = started(() => noGenerated);
    blocked(fake.call("read", { path: "a.ts" }, {}), "cwd");
    blocked(fake.call("read", { path: "a.ts" }, null), "cwd");
    const [result] = fake.handlers.get("tool_call")?.map((handler) => handler(null, { cwd: project })) ?? [];
    blocked(result, "tool call");
  });

  test("a refusing decide is never bypassed by a later call", () => {
    const refuseAll: Decide = () => Verdict.refuse("nothing runs here", "Ask the maintainer");
    const fake = started(() => refuseAll);
    for (const [tool, input] of [["bash", { command: "ls" }], ["web_search", { query: "x" }], ["mystery", {}]] as const) {
      expect(fake.call(tool, input)).toEqual({ block: true, reason: "nothing runs here\nAsk the maintainer" });
    }
  });
});
