import { describe, expect, test } from "bun:test";
import type { Event as EventType } from "../events/event.contract.ts";
import type { SessionStart } from "../events/session-start.contract.ts";
import { SessionStart as SessionStartFactory } from "../events/session-start.ts";
import { ToolUse } from "../events/tool-use.ts";
import type { ToolUse as ToolUseType } from "../events/tool-use.contract.ts";
import { Verdict } from "../verdicts/verdict.ts";
import type { Guard } from "./guard.contract.ts";
import { dispatch } from "./dispatch.ts";

const parsed = ToolUse.parse({ role: "builder", tool: "edit", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] });
if (!parsed.ok) throw new Error(parsed.error);
const write: ToolUseType = parsed.value;

const FIX = "Fix the guard so it returns Verdict.allow or Verdict.refuse(reason, redirect), or remove it. Until then the action is refused";
const allow: Guard<ToolUseType> = () => Verdict.allow;
const generated: Guard<ToolUseType> = () => Verdict.refuse("Generated file", "Change the generator's input instead");

/** Guards written without types, as untyped data would bring them. */
const untyped = (...guards: unknown[]): Guard<ToolUseType>[] => guards as Guard<ToolUseType>[];

describe("dispatch — the verdict", () => {
  test("with no guards, allows", () => {
    expect(dispatch([], write)).toBe(Verdict.allow);
  });

  test("when every guard allows, allows", () => {
    expect(dispatch([allow, allow], write)).toEqual(Verdict.allow);
  });

  test("a refusal carries its reason and redirect", () => {
    expect<unknown>(dispatch([allow, generated], write)).toEqual({ kind: "refuse", reason: "Generated file", redirect: "Change the generator's input instead" });
  });

  test("runs guards in the given order, and the first refusal wins: later guards never run", () => {
    const calls: string[] = [];
    const guard = (name: string, verdict: Verdict): Guard<ToolUseType> => () => {
      calls.push(name);
      return verdict;
    };
    const verdict = dispatch([guard("a", Verdict.allow), guard("b", Verdict.refuse("b refuses", "ask b")), guard("c", Verdict.refuse("c refuses", "ask c"))], write);
    expect(calls).toEqual(["a", "b"]);
    expect<unknown>(verdict).toEqual({ kind: "refuse", reason: "b refuses", redirect: "ask b" });
  });

  test("every guard receives the event and the context", () => {
    const seen: unknown[] = [];
    const guard: Guard<ToolUseType, { readonly project: string }> = (event, context) => {
      seen.push([event, context]);
      return Verdict.allow;
    };
    dispatch([guard, guard], write, { project: "demo" });
    expect(seen).toEqual([[write, { project: "demo" }], [write, { project: "demo" }]]);
  });

  test("dispatches a session start like any other event", () => {
    const started = SessionStartFactory.parse({ role: null });
    if (!started.ok) throw new Error(started.error);
    const start = started.value;
    const parsedStart = dispatch([(event: SessionStart) => Verdict.refuse(`No session without a role (${String(event.role)})`, "Start the session as a role")], start);
    expect<unknown>(parsedStart).toEqual({ kind: "refuse", reason: "No session without a role (null)", redirect: "Start the session as a role" });
  });
});

describe("dispatch — guards see only the checked event", () => {
  /** An event as untyped data would bring it, unchecked. */
  const raw = (fields: object): ToolUseType => fields as ToolUseType;
  const seenBy = (event: ToolUseType): EventType[] => {
    const seen: EventType[] = [];
    dispatch([(e) => { seen.push(e); return Verdict.allow; }], event);
    return seen;
  };

  test("a guard receives normalised paths, so it cannot be dodged by spelling a path differently", () => {
    const noGenerated: Guard<ToolUseType> = (event) =>
      event.effects.some((effect) => effect.kind === "write" && effect.path.startsWith("generated/")) ? Verdict.refuse("Generated file", "Change the generator's input instead") : Verdict.allow;
    const event = raw({ kind: "tool-use", role: null, tool: "edit", effects: [{ kind: "write", path: "./generated//api.ts", change: "modify" }] });
    expect(dispatch([noGenerated], event).kind).toBe("refuse");
    expect<unknown>(seenBy(event)[0]).toEqual({ kind: "tool-use", role: null, tool: "edit", effects: [{ kind: "write", path: "generated/api.ts", change: "modify" }] });
  });

  test("extra fields never reach a guard, and missing optional ones arrive as null", () => {
    const [seen] = seenBy(raw({ kind: "tool-use", role: null, tool: "search", effects: [{ kind: "list", root: "src" }], content: "secret" }));
    expect(seen !== undefined && Object.hasOwn(seen, "content")).toBe(false);
    expect<unknown>(seen?.kind === "tool-use" && seen.effects).toEqual([{ kind: "list", root: "src", filter: null }]);
  });

  test("a guard sees a frozen copy: one that tries to change it affects neither later guards nor the caller", () => {
    const event = raw({ kind: "tool-use", role: null, tool: "read", effects: [{ kind: "read", path: "a.ts" }] });
    const meddler: Guard<ToolUseType> = (e) => {
      try {
        (e.effects as unknown as object[]).push({ kind: "read", path: "b.ts" });
      } catch {
        // frozen: the change is refused
      }
      return Verdict.allow;
    };
    const later: number[] = [];
    dispatch([meddler, (e) => { later.push(e.effects.length); return Verdict.allow; }], event);
    expect(later).toEqual([1]);
    expect<unknown>(event.effects).toEqual([{ kind: "read", path: "a.ts" }]);
  });

  test("a getter on the input is read once, by the check; guards see the value it gave", () => {
    let reads = 0;
    const event = raw({
      kind: "tool-use",
      role: null,
      tool: "edit",
      get effects() {
        reads += 1;
        return [{ kind: "write", path: reads === 1 ? "generated/a.ts" : "safe.ts", change: "modify" }];
      },
    });
    const seen = seenBy(event);
    expect(reads).toBe(1);
    expect<unknown>(seen[0]?.kind === "tool-use" && seen[0].effects).toEqual([{ kind: "write", path: "generated/a.ts", change: "modify" }]);
  });
});

describe("dispatch — fail closed, never throws", () => {
  test("a guard that throws refuses, naming the guard by its position and the error", () => {
    const broken: Guard<ToolUseType> = () => {
      throw new Error("rules file missing");
    };
    expect<unknown>(dispatch([allow, broken, allow], write)).toEqual({ kind: "refuse", reason: "Guard 2 of 3 threw: rules file missing", redirect: FIX });
  });

  test("a guard that throws something other than an error, or something unprintable, still refuses", () => {
    expect<unknown>(dispatch(untyped(() => { throw "bad"; }), write)).toEqual({ kind: "refuse", reason: "Guard 1 of 1 threw: bad", redirect: FIX });
    const unprintable = { toString: () => { throw new Error("no"); } };
    expect<unknown>(dispatch(untyped(() => { throw unprintable; }), write)).toEqual({ kind: "refuse", reason: "Guard 1 of 1 threw: a value that cannot be printed", redirect: FIX });
  });

  test("a guard that returns something that is not a verdict refuses, saying what a verdict is", () => {
    for (const garbage of [undefined, true, "allow", { kind: "deny" }, { kind: "refuse", reason: "r" }]) {
      expect<unknown>(dispatch(untyped(() => garbage), write)).toEqual({
        kind: "refuse",
        reason: "Guard 1 of 1 returned something that is not a verdict: A verdict is { kind: 'allow' } or { kind: 'refuse', reason, redirect } with a non-empty reason and redirect",
        redirect: FIX,
      });
    }
  });

  test("a well-formed plain verdict from untyped code is accepted as that verdict", () => {
    expect<unknown>(dispatch(untyped(() => ({ kind: "refuse", reason: " r ", redirect: "d" })), write)).toEqual({ kind: "refuse", reason: "r", redirect: "d" });
    expect(dispatch(untyped(() => ({ kind: "allow" })), write).kind).toBe("allow");
  });

  test("a guard that returns a promise refuses: guards are synchronous", () => {
    const later = async () => Verdict.allow;
    expect<unknown>(dispatch(untyped(later), write)).toEqual({ kind: "refuse", reason: "Guard 1 of 1 returned a promise. Guards are synchronous and return a verdict", redirect: FIX });
  });

  test("a guard whose result cannot be read refuses", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("trap"); } });
    expect<unknown>(dispatch(untyped(() => hostile), write)).toEqual({ kind: "refuse", reason: "Guard 1 of 1 returned something that cannot be read: trap", redirect: FIX });
  });

  test("a guard that is not a function refuses", () => {
    expect<unknown>(dispatch(untyped(allow, "allow"), write)).toEqual({ kind: "refuse", reason: "Guard 2 of 2 is not a function", redirect: FIX });
  });

  test("guards that are not a list refuse", () => {
    expect<unknown>(dispatch(untyped as never, write)).toEqual({
      kind: "refuse",
      reason: "Dispatch was given guards that are not a list",
      redirect: "Pass the guards for this event as a list; with no guards, pass []",
    });
  });

  test("an invalid event refuses without running any guard", () => {
    let ran = false;
    const verdict = dispatch([() => { ran = true; return Verdict.allow; }], { kind: "tool-use", role: null, tool: "edit", effects: [{ kind: "write", path: "../x", change: "create" }] } as unknown as ToolUseType);
    expect(ran).toBe(false);
    expect<unknown>(verdict).toEqual({
      kind: "refuse",
      reason: "Dispatch was given an invalid event: Effect 1 of 1: Path '../x' climbs out of the project with '..'. Only paths inside the project can be checked",
      redirect: "Build the event with Event.parse, ToolUse.parse or SessionStart.parse",
    });
  });

  test("extra fields on a verdict are dropped; an unknown verdict kind is refused", () => {
    expect<unknown>(dispatch(untyped(() => ({ kind: "refuse", reason: "r", redirect: "d", rewrite: "x" })), write)).toEqual({ kind: "refuse", reason: "r", redirect: "d" });
    expect<unknown>(dispatch(untyped(() => ({ kind: "rewrite", input: {} })), write)).toEqual({
      kind: "refuse",
      reason: "Guard 1 of 1 returned something that is not a verdict: A verdict is { kind: 'allow' } or { kind: 'refuse', reason, redirect } with a non-empty reason and redirect",
      redirect: FIX,
    });
  });

  test("anything else that goes wrong while dispatching refuses", () => {
    const hostile = new Proxy([allow], { get: () => { throw new Error("trap"); } });
    expect<unknown>(dispatch(hostile, write)).toEqual({
      kind: "refuse",
      reason: "Dispatch could not finish: trap",
      redirect: "Report this to the maintainers of bounded; the action is refused meanwhile",
    });
  });
});
