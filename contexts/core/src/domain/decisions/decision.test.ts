import { describe, expect, test } from "bun:test";
import { SessionStart } from "../events/session-start.ts";
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
    expect<unknown>(Decision.of(TIME, use.value, { verdict: Verdict.allow, refusedBy: null })).toEqual({
      time: TIME,
      event: "tool-use",
      role: "builder",
      tool: "edit",
      effects: ["read a.ts", "write (modify) generated/x.ts"],
      verdict: { kind: "allow" },
    });
  });

  test("records a refusal with its reason, redirect, refusing pack and effect", () => {
    const [, write] = use.value.effects;
    if (write === undefined) throw new Error("expected a write");
    const refusal = Verdict.refuse("test-packs/gate refused write (modify) generated/x.ts: generated", "Change the generator's input");
    expect<unknown>(Decision.of(TIME, use.value, { verdict: refusal, refusedBy: { pack: gate, effect: write } }).verdict).toEqual({
      kind: "refuse",
      reason: "test-packs/gate refused write (modify) generated/x.ts: generated",
      redirect: "Change the generator's input",
      pack: "test-packs/gate",
      effect: "write (modify) generated/x.ts",
    });
  });

  test("a refusal no pack made, or a whole-call refusal, records what it knows", () => {
    const refusal = Verdict.refuse("No guards can be found", "Select the core");
    expect<unknown>(Decision.of(TIME, use.value, { verdict: refusal, refusedBy: null }).verdict).toEqual({ kind: "refuse", reason: "No guards can be found", redirect: "Select the core", pack: null, effect: null });
    expect<unknown>(Decision.of(TIME, use.value, { verdict: refusal, refusedBy: { pack: gate, effect: null } }).verdict).toEqual({ kind: "refuse", reason: "No guards can be found", redirect: "Select the core", pack: "test-packs/gate", effect: null });
  });

  test("records a session start with no tool and no effects", () => {
    expect<unknown>(Decision.of(TIME, start.value, { verdict: Verdict.allow, refusedBy: null })).toEqual({ time: TIME, event: "session-start", role: null, tool: null, effects: [], verdict: { kind: "allow" } });
  });

  test("is plain, frozen, serialisable data", () => {
    const decision = Decision.of(TIME, use.value, { verdict: Verdict.allow, refusedBy: null });
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
    expect(Object.isFrozen(decision) && Object.isFrozen(decision.effects) && Object.isFrozen(decision.verdict)).toBe(true);
  });
});
