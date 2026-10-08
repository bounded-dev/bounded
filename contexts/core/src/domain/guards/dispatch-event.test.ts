import { describe, expect, test } from "bun:test";
import { wireOf } from "../shared/value-object.laws.test-support.ts";
import { Composition } from "../composition/composition.ts";
import type { Composition as CompositionType } from "../composition/composition.contract.ts";
import type { Effect, EffectByKind, EffectKind, ReadEffect, WriteEffect } from "../events/effect.contract.ts";
import { SessionStart } from "../events/session-start.ts";
import type { SessionStart as SessionStartType } from "../events/session-start.contract.ts";
import { ToolUse } from "../events/tool-use.ts";
import type { ToolUse as ToolUseType } from "../events/tool-use.contract.ts";
import { type BasePack, contribution, definePack, point } from "../packs/pack.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import { Verdict } from "../verdicts/verdict.ts";
import { corePack } from "./core-pack.ts";
import { decideEvent, dispatchEvent } from "./dispatch-event.ts";
import type { EffectGuard, Guard } from "./dispatch.contract.ts";

const packId = packIdsFor("test-packs");
const guards = corePack.points;
const FIX = "Fix the guard so it returns Verdict.allow or Verdict.refuse(reason, redirect), or remove it. Until then the action is refused";

function call(effects: object[], role: string | null = "builder"): ToolUseType {
  const parsed = ToolUse.parse({ role, tool: "edit", effects });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
const write = call([{ kind: "write", path: "src/x.ts", change: "modify" }]);

function composed(available: readonly BasePack[], selected: readonly BasePack[] = available): CompositionType {
  const result = Composition.compose(available, selected);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** A guard that records `name` each time it runs and returns `verdict`. */
function recording(calls: string[], name: string, verdict: Verdict = Verdict.allow): () => Verdict {
  return () => {
    calls.push(name);
    return verdict;
  };
}

describe("dispatchEvent — whole calls, then each effect", () => {
  test("with the core and no guards, allows", () => {
    expect(dispatchEvent(composed([corePack]), write)).toBe(Verdict.allow);
  });

  test("runs guards in pack composition order, dependencies first, and in contribution order within a pack", () => {
    const calls: string[] = [];
    const a = definePack({ id: packId("a"), dependsOn: [corePack], contributes: [contribution(guards.toolUseGuards, [recording(calls, "a1"), recording(calls, "a2")])] });
    const b = definePack({ id: packId("b"), dependsOn: [corePack, a], contributes: [contribution(guards.toolUseGuards, [recording(calls, "b1")])] });
    const c = definePack({ id: packId("c"), dependsOn: [corePack], contributes: [contribution(guards.toolUseGuards, [recording(calls, "c1")])] });
    expect(dispatchEvent(composed([c, b, a, corePack]), write)).toBe(Verdict.allow);
    expect(calls).toEqual(["a1", "a2", "b1", "c1"]);
  });

  test("whole-call guards run first, then each effect in order through the guards for its kind, in pack order", () => {
    const calls: string[] = [];
    const a = definePack({
      id: packId("a"),
      dependsOn: [corePack],
      contributes: [contribution(guards.effectGuards.write, [recording(calls, "a write")]), contribution(guards.effectGuards.read, [recording(calls, "a read")])],
    });
    const b = definePack({
      id: packId("b"),
      dependsOn: [corePack],
      contributes: [contribution(guards.effectGuards.read, [recording(calls, "b read")]), contribution(guards.toolUseGuards, [recording(calls, "b call")])],
    });
    const rename = call([{ kind: "read", path: "a.ts" }, { kind: "write", path: "a.ts", change: "delete" }, { kind: "write", path: "b.ts", change: "create" }]);
    expect(dispatchEvent(composed([b, a, corePack]), rename)).toBe(Verdict.allow);
    expect(calls).toEqual(["b call", "a read", "b read", "a write", "a write"]);
  });

  test("each effect kind reaches only its own guards", () => {
    const seen: string[] = [];
    const note = (name: string) => (effect: Effect) => {
      seen.push(`${name}:${effect.kind}`);
      return Verdict.allow;
    };
    const all = definePack({
      id: packId("all"),
      dependsOn: [corePack],
      contributes: [
        contribution(guards.effectGuards.read, [note("read")]),
        contribution(guards.effectGuards.list, [note("list")]),
        contribution(guards.effectGuards.write, [note("write")]),
        contribution(guards.effectGuards.execute, [note("execute")]),
        contribution(guards.effectGuards.fetch, [note("fetch")]),
        contribution(guards.effectGuards.delegate, [note("delegate")]),
        contribution(guards.effectGuards.invoke, [note("invoke")]),
      ],
    });
    const everything = call([
      { kind: "invoke", name: "mcp__docs__search" },
      { kind: "delegate", agent: "explore" },
      { kind: "fetch", url: "https://example.com" },
      { kind: "execute", command: "make" },
      { kind: "write", path: "a.ts", change: "create" },
      { kind: "list", root: "." },
      { kind: "read", path: "a.ts" },
    ]);
    expect(dispatchEvent(composed([all, corePack]), everything)).toBe(Verdict.allow);
    expect(seen).toEqual(["invoke:invoke", "delegate:delegate", "fetch:fetch", "execute:execute", "write:write", "list:list", "read:read"]);
  });

  const everyKind = call([
    { kind: "invoke", name: "mcp__docs__search" },
    { kind: "delegate", agent: "explore" },
    { kind: "fetch", url: "https://example.com" },
    { kind: "execute", command: "make" },
    { kind: "write", path: "a.ts", change: "create" },
    { kind: "list", root: "." },
    { kind: "read", path: "a.ts" },
  ]);
  /** A contribution of `guard` to the point for `kind`. */
  const guarding = <K extends EffectKind>(kind: K, guard: EffectGuard<EffectByKind[K]>) => contribution(guards.effectGuards[kind], [guard]);
  for (const kind of ["read", "list", "write", "execute", "fetch", "delegate", "invoke"] as const) {
    test(`a guard contributed to effectGuards.${kind} sees only ${kind} effects`, () => {
      const seen: string[] = [];
      const guard = (effect: Effect) => {
        seen.push(effect.kind);
        return Verdict.allow;
      };
      const one = definePack({ id: packId("one"), dependsOn: [corePack], contributes: [guarding(kind, guard)] });
      expect(dispatchEvent(composed([one, corePack]), everyKind)).toBe(Verdict.allow);
      expect(seen).toEqual([kind]);
    });
  }

  test("an effect kind with no guards is allowed", () => {
    const onlyWrites = definePack({ id: packId("writes"), dependsOn: [corePack], contributes: [contribution(guards.effectGuards.write, [() => Verdict.refuse("No writes", "Ask")])] });
    expect(dispatchEvent(composed([onlyWrites, corePack]), call([{ kind: "read", path: "a.ts" }, { kind: "execute", command: "ls" }]))).toBe(Verdict.allow);
  });

  test("one refused effect refuses the whole call; the refusal names the pack and the effect", () => {
    const calls: string[] = [];
    const gate = definePack({
      id: packId("gate"),
      dependsOn: [corePack],
      contributes: [
        contribution(guards.effectGuards.write, [
          (effect: WriteEffect) => {
            calls.push(effect.path.value);
            return effect.path.value.startsWith("generated/") ? Verdict.refuse("generated/ belongs to the generator", "Change the generator's input instead") : Verdict.allow;
          },
        ]),
      ],
    });
    const multi = call([{ kind: "write", path: "src/a.ts", change: "modify" }, { kind: "write", path: "generated/api.ts", change: "modify" }, { kind: "write", path: "src/b.ts", change: "modify" }]);
    expect<unknown>(dispatchEvent(composed([gate, corePack]), multi)).toEqual({
      kind: "refuse",
      reason: "test-packs/gate refused write (modify) generated/api.ts: generated/ belongs to the generator",
      redirect: "Change the generator's input instead",
    });
    expect(calls).toEqual(["src/a.ts", "generated/api.ts"]);
  });

  test("a whole-call refusal names the pack", () => {
    const tools = definePack({ id: packId("tools"), dependsOn: [corePack], contributes: [contribution(guards.toolUseGuards, [(use) => (use.toolKind === "edit" ? Verdict.refuse("No editing tools", "Use the generator") : Verdict.allow)])] });
    expect<unknown>(dispatchEvent(composed([tools, corePack]), write)).toEqual({ kind: "refuse", reason: "test-packs/tools refused: No editing tools", redirect: "Use the generator" });
  });

  test("an effect guard receives the effect, the composition and the whole call, so role rules and other points can apply", () => {
    const text = (raw: unknown): Result<string> => (typeof raw === "string" ? { ok: true, value: raw } : { ok: false, error: "a prefix is text" });
    const rules = definePack({ id: packId("rules"), points: { protectedPaths: point({ description: "Protected path prefixes", check: text, values: ["generated/"] }) } });
    const gate = definePack({
      id: packId("gate"),
      dependsOn: [corePack, rules],
      contributes: [
        contribution(guards.effectGuards.read, [
          (effect: ReadEffect, composition, whole) => {
            const prefixes = composition.read(rules.points.protectedPaths);
            if (!prefixes.ok) return Verdict.refuse(prefixes.error, "Select the rules pack");
            return whole.role?.value !== "reviewer" && prefixes.value.some((prefix) => effect.path.value.startsWith(prefix)) ? Verdict.refuse("Protected", "Ask a reviewer") : Verdict.allow;
          },
        ]),
      ],
    });
    const composition = composed([gate, rules, corePack]);
    expect<unknown>(dispatchEvent(composition, call([{ kind: "read", path: "generated/a.ts" }]))).toEqual({ kind: "refuse", reason: "test-packs/gate refused read generated/a.ts: Protected", redirect: "Ask a reviewer" });
    expect(dispatchEvent(composition, call([{ kind: "read", path: "generated/a.ts" }], "reviewer"))).toBe(Verdict.allow);
  });

  test("a guard that fails is a refusal naming its pack and the effect", () => {
    const broken = definePack({
      id: packId("broken"),
      dependsOn: [corePack],
      contributes: [
        contribution(guards.effectGuards.read, [
          () => {
            throw new Error("rules file vanished");
          },
        ]),
      ],
    });
    expect<unknown>(dispatchEvent(composed([broken, corePack]), call([{ kind: "read", path: "a.ts" }]))).toEqual({
      kind: "refuse",
      reason: "A guard from test-packs/broken for read a.ts threw: rules file vanished",
      redirect: FIX,
    });
  });

  test("a guard that returns something other than a verdict is a refusal naming its pack", () => {
    const sloppy = definePack({ id: packId("sloppy"), dependsOn: [corePack], contributes: [contribution(guards.toolUseGuards, [(() => true) as unknown as Guard<ToolUseType>])] });
    const verdict = dispatchEvent(composed([sloppy, corePack]), write);
    expect(verdict.kind === "refuse" && verdict.reason.startsWith("A guard from test-packs/sloppy returned something that is not a verdict")).toBe(true);
  });

  test("a pack that is not selected leaves its guards out", () => {
    const calls: string[] = [];
    const refusing = definePack({ id: packId("refusing"), dependsOn: [corePack], contributes: [contribution(guards.effectGuards.write, [recording(calls, "never", Verdict.refuse("no", "no"))])] });
    expect(dispatchEvent(composed([refusing, corePack], [corePack]), write)).toBe(Verdict.allow);
    expect(calls).toEqual([]);
  });

  test("a session start runs only the session-start guards", () => {
    const calls: string[] = [];
    const onStart: Guard<SessionStartType> = () => {
      calls.push("start");
      return Verdict.refuse("No session without a role", "Start as a role");
    };
    const pack = definePack({
      id: packId("sessions"),
      dependsOn: [corePack],
      contributes: [contribution(guards.sessionStartGuards, [onStart]), contribution(guards.toolUseGuards, [recording(calls, "tool")]), contribution(guards.effectGuards.write, [recording(calls, "write")])],
    });
    const started = SessionStart.parse({ role: null });
    if (!started.ok) throw new Error(started.error);
    expect<unknown>(dispatchEvent(composed([pack, corePack]), started.value)).toEqual({
      kind: "refuse",
      reason: "test-packs/sessions refused: No session without a role",
      redirect: "Start as a role",
    });
    expect(calls).toEqual(["start"]);
  });
});

describe("dispatchEvent — fails closed", () => {
  test("without the core pack, no guard can be found, so every event is refused", () => {
    const other = definePack({ id: packId("other") });
    expect<unknown>(dispatchEvent(composed([other]), write)).toEqual({
      kind: "refuse",
      reason: "No guards can be found: the core pack 'bounded/core' is not selected, so nothing can decide this event",
      redirect: "Select the core pack 'bounded/core' with the packs that contribute guards; until then every event is refused",
    });
  });

  test("something that is not a composition is refused, never thrown", () => {
    expect<unknown>(dispatchEvent(null as unknown as CompositionType, write)).toEqual({
      kind: "refuse",
      reason: "Dispatch was given something that is not a composition",
      redirect: "Compose the selected packs with Composition.compose and dispatch over the result",
    });
  });

  test("a guard point value that is not a function is refused when the packs are composed", () => {
    const bad = (definePack as unknown as (spec: object) => BasePack)({
      id: "test-packs/bad",
      dependsOn: [corePack],
      contributes: [contribution(guards.effectGuards.write, ["not a guard" as unknown as EffectGuard<WriteEffect>])],
    });
    expect(Composition.compose([bad, corePack], [bad, corePack])).toEqual({
      ok: false,
      error: "Pack 'test-packs/bad' contributes an invalid value to extension point 'bounded/core.effectGuards.write': a guard is a function. Fix the value, or remove the contribution",
    });
  });
});

describe("dispatchEvent — refuses what it cannot trust", () => {
  test("a look-alike composition, however well it imitates one, is refused", () => {
    const forged = { __brand: "Composition", packs: [corePack], entries: () => ({ ok: true, value: [] }), read: () => ({ ok: true, value: [] }) } as unknown as CompositionType;
    expect<unknown>(dispatchEvent(forged, write)).toEqual({
      kind: "refuse",
      reason: "Dispatch was given something that is not a composition",
      redirect: "Compose the selected packs with Composition.compose and dispatch over the result",
    });
  });

  test("a guard that dispatches again is refused briefly, not with a stack overflow", () => {
    let composition: CompositionType | undefined;
    const looping = definePack({
      id: packId("looping"),
      dependsOn: [corePack],
      contributes: [contribution(guards.toolUseGuards, [(use) => (composition === undefined ? Verdict.allow : dispatchEvent(composition, use))])],
    });
    composition = composed([looping, corePack]);
    const verdict = dispatchEvent(composition, write);
    expect<unknown>(verdict).toEqual({
      kind: "refuse",
      reason: "test-packs/looping refused: Dispatch was called from inside a guard; guards decide events, they do not dispatch them",
      redirect: "Remove the call to dispatch from the guard",
    });
  });

  test("a guard's very long refusal is shortened", () => {
    const wordy = definePack({ id: packId("wordy"), dependsOn: [corePack], contributes: [contribution(guards.toolUseGuards, [() => Verdict.refuse("w".repeat(10_000), "Ask")])] });
    const verdict = dispatchEvent(composed([wordy, corePack]), write);
    expect(verdict.kind === "refuse" && verdict.reason.length).toBeLessThan(2100);
    expect(verdict.kind === "refuse" && verdict.reason.endsWith("characters)")).toBe(true);
  });
});

describe("decideEvent — the verdict and who refused", () => {
  test("names the refusing pack and effect, or the pack alone for a whole call, or nobody", () => {
    const gate = definePack({
      id: packId("gate"),
      dependsOn: [corePack],
      contributes: [contribution(guards.effectGuards.write, [() => Verdict.refuse("No writes", "Ask")]), contribution(guards.toolUseGuards, [(use) => (use.toolKind === "shell" ? Verdict.refuse("No shell", "Ask") : Verdict.allow)])],
    });
    const composition = composed([gate, corePack]);
    const refused = decideEvent(composition, call([{ kind: "read", path: "a.ts" }, { kind: "write", path: "b.ts", change: "create" }]));
    expect(refused.verdict.kind).toBe("refuse");
    expect(wireOf(refused.refusedBy)).toEqual({ packId: "test-packs/gate", effect: { kind: "write", path: "b.ts", change: "create" } });
    const shell = ToolUse.parse({ role: null, tool: "shell", effects: [{ kind: "execute", command: "ls" }] });
    if (!shell.ok) throw new Error(shell.error);
    expect(wireOf(decideEvent(composition, shell.value).refusedBy)).toEqual({ packId: "test-packs/gate", effect: null });
    expect(decideEvent(composition, call([{ kind: "read", path: "a.ts" }]))).toEqual({ verdict: Verdict.allow, refusedBy: null });
    expect(decideEvent(composed([gate, corePack], [corePack]), write).refusedBy).toBeNull();
    expect(decideEvent(composed([definePack({ id: packId("other") })]), write).refusedBy).toBeNull();
  });

  test("a failing guard is attributed to its pack", () => {
    const broken = definePack({ id: packId("broken"), dependsOn: [corePack], contributes: [contribution(guards.effectGuards.read, [() => { throw new Error("x"); }])] });
    const judged = decideEvent(composed([broken, corePack]), call([{ kind: "read", path: "a.ts" }]));
    expect(wireOf(judged.refusedBy)).toEqual({ packId: "test-packs/broken", effect: { kind: "read", path: "a.ts" } });
  });
});

describe("corePack", () => {
  test("is the pack bounded/core, declaring a guards point per event kind and per effect kind", () => {
    expect(corePack.id.value).toBe("bounded/core");
    expect(Object.keys(corePack.points).sort()).toEqual(["afterTool", "beforeTool", "effectGuards", "onProjectOpen", "sessionStartGuards", "toolUseGuards"]);
    expect(Object.keys(corePack.points.effectGuards).sort()).toEqual(["delegate", "execute", "fetch", "invoke", "list", "read", "write"]);
    expect(corePack.dependsOn).toEqual([]);
  });
});
