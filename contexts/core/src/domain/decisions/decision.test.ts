import { describe, expect, test } from "bun:test";
import { SessionStart } from "../events/session-start.ts";
import { ToolResult } from "../events/tool-result.ts";
import { ToolUse } from "../events/tool-use.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import { Verdict } from "../verdicts/verdict.ts";
import { Decision } from "./decision.ts";

const TIME = "2026-10-07T12:00:00.000Z";
const use = ToolUse.parse({ role: "builder", tool: "edit", effects: [{ kind: "read", path: "a.ts" }, { kind: "write", path: "generated/x.ts", change: "modify" }] });
const start = SessionStart.parse({ role: null });
if (!use.ok || !start.ok) throw new Error("expected events");
const gate = packIdsFor("test-packs")("gate");

describe("Decision", () => {
  test("records an allowed tool use: when, who, which tool and every effect, described", () => {
    expect<unknown>(Decision.of("d-1", TIME, use.value, { verdict: Verdict.allow, refusedBy: null })).toEqual({
      id: "d-1",
      time: TIME,
      event: "tool-use",
      role: "builder",
      tool: "edit",
      effects: ["read a.ts", "write (modify) generated/x.ts"],
      verdict: { kind: "allow" },
      note: null,
    });
  });

  test("records a refusal with its reason, redirect, refusing pack and effect", () => {
    const [, write] = use.value.effects;
    if (write === undefined) throw new Error("expected a write");
    const refusal = Verdict.refuse("test-packs/gate refused write (modify) generated/x.ts: generated", "Change the generator's input");
    expect<unknown>(Decision.of("d-2", TIME, use.value, { verdict: refusal, refusedBy: { pack: gate, effect: write } }).verdict).toEqual({
      kind: "refuse",
      reason: "test-packs/gate refused write (modify) generated/x.ts: generated",
      redirect: "Change the generator's input",
      pack: "test-packs/gate",
      effect: "write (modify) generated/x.ts",
    });
  });

  test("a refusal no pack made, or a whole-call refusal, records what it knows", () => {
    const refusal = Verdict.refuse("No guards can be found", "Select the core");
    expect<unknown>(Decision.of("d-3", TIME, use.value, { verdict: refusal, refusedBy: null }).verdict).toEqual({ kind: "refuse", reason: "No guards can be found", redirect: "Select the core", pack: null, effect: null });
    expect<unknown>(Decision.of("d-4", TIME, use.value, { verdict: refusal, refusedBy: { pack: gate, effect: null } }).verdict).toEqual({ kind: "refuse", reason: "No guards can be found", redirect: "Select the core", pack: "test-packs/gate", effect: null });
  });

  test("records a session start with no tool and no effects", () => {
    expect<unknown>(Decision.of("d-5", TIME, start.value, { verdict: Verdict.allow, refusedBy: null })).toEqual({ id: "d-5", time: TIME, event: "session-start", role: null, tool: null, effects: [], verdict: { kind: "allow" }, note: null });
  });

  test("text past 4,096 characters is shortened, saying so, so a log line stays bounded", () => {
    const long = ToolUse.parse({ role: null, tool: "shell", effects: [{ kind: "execute", command: "x".repeat(10_000) }] });
    if (!long.ok) throw new Error(long.error);
    const [effect] = Decision.of("d-7", TIME, long.value, { verdict: Verdict.allow, refusedBy: null }).effects;
    expect(effect).toBe(`execute \`${"x".repeat(4096 - "execute `".length)}… (shortened from ${10_000 + "execute ``".length} characters)`);
  });

  test("shortening a field never splits a character made of two code units", () => {
    const emoji = ToolUse.parse({ role: null, tool: "shell", effects: [{ kind: "execute", command: "😀".repeat(5000) }] });
    if (!emoji.ok) throw new Error(emoji.error);
    const [effect] = Decision.of("d-11", TIME, emoji.value, { verdict: Verdict.allow, refusedBy: null }).effects;
    expect(effect?.includes("\ud83d…")).toBe(false);
    expect(effect?.endsWith("… (shortened from 5010 characters)")).toBe(true);
  });

  test("a follow-up keeps the decision's id and says what was enforced instead", () => {
    const decision = Decision.of("d-8", TIME, use.value, { verdict: Verdict.allow, refusedBy: null });
    const late = Decision.enforced(decision, "2026-10-07T12:00:05.000Z", Verdict.refuse("Not recorded in time", "Fix the log"), "not recorded in time; enforced: refuse");
    expect<unknown>(late).toEqual({
      ...JSON.parse(JSON.stringify(decision)),
      time: "2026-10-07T12:00:05.000Z",
      verdict: { kind: "refuse", reason: "Not recorded in time", redirect: "Fix the log", pack: null, effect: null },
      note: "not recorded in time; enforced: refuse",
    });
  });

  test("records the directory a command runs in", () => {
    const inApp = ToolUse.parse({ role: null, tool: "shell", effects: [{ kind: "execute", command: "make", cwd: "apps/web" }] });
    if (!inApp.ok) throw new Error(inApp.error);
    expect(Decision.of("d-9", TIME, inApp.value, { verdict: Verdict.allow, refusedBy: null }).effects).toEqual(["execute `make` in apps/web"]);
  });

  test("records an event that could not be read, with the refusal it got", () => {
    expect<unknown>(Decision.invalid("d-10", TIME, Verdict.refuse("The event cannot be read", "Fix the adapter"))).toEqual({
      id: "d-10",
      time: TIME,
      event: "invalid",
      role: null,
      tool: null,
      effects: [],
      verdict: { kind: "refuse", reason: "The event cannot be read", redirect: "Fix the adapter", pack: null, effect: null },
      note: null,
    });
  });

  test("records a finished tool call, with a note", () => {
    const result = ToolResult.parse({ kind: "tool-result", role: "builder", tool: "shell", effects: [{ kind: "execute", command: "make" }], ok: true, callId: "c1" });
    if (!result.ok) throw new Error(result.error);
    const decision = Decision.of("d-12", TIME, result.value, { verdict: Verdict.refuse("changed", "restore"), refusedBy: null }, "changed by a shell command; restored");
    expect<unknown>(decision).toEqual({
      id: "d-12",
      time: TIME,
      event: "tool-result",
      role: "builder",
      tool: "shell",
      effects: ["execute `make`"],
      verdict: { kind: "refuse", reason: "changed", redirect: "restore", pack: null, effect: null },
      note: "changed by a shell command; restored",
    });
  });

  test("records a call the host adapter refused before the core saw an event: the host's tool and a bounded summary of its input", () => {
    expect<unknown>(Decision.adapter("d-13", TIME, { role: "builder", tool: "Bash", input: { command: "ls" }, verdict: Verdict.refuse("outside the project", "Stay inside") })).toEqual({
      id: "d-13",
      time: TIME,
      event: "adapter",
      role: "builder",
      tool: null,
      effects: [],
      verdict: { kind: "refuse", reason: "outside the project", redirect: "Stay inside", pack: null, effect: null },
      note: null,
      host: { tool: "Bash", input: '{"command":"ls"}' },
    });
    const huge = Decision.adapter("d-14", TIME, { role: null, tool: "Write", input: { content: "x".repeat(10_000) }, verdict: Verdict.refuse("r", "d") });
    expect(huge.host?.input.endsWith("characters)")).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(Decision.adapter("d-15", TIME, { role: null, tool: "X", input: cyclic, verdict: Verdict.refuse("r", "d") }).host?.input).toBe("an input that cannot be shown");
  });

  test("is plain, frozen, serialisable data", () => {
    const decision = Decision.of("d-6", TIME, use.value, { verdict: Verdict.allow, refusedBy: null });
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
    expect(Object.isFrozen(decision) && Object.isFrozen(decision.effects) && Object.isFrozen(decision.verdict)).toBe(true);
  });
});
