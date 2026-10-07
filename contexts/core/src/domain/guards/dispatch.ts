import { Event } from "../events/event.ts";
import { Verdict } from "../verdicts/verdict.ts";
import type * as Contract from "./guard.contract.ts";

const FIX = "Fix the guard so it returns Verdict.allow or Verdict.refuse(reason, redirect), or remove it. Until then the action is refused";

/** Text for any thrown value, even one whose toString throws. */
function describe(thrown: unknown): string {
  try {
    return thrown instanceof Error ? thrown.message : String(thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

function decide(guard: unknown, label: string, event: unknown, context: unknown): Verdict | undefined {
  if (typeof guard !== "function") return Verdict.refuse(`${label} is not a function`, FIX);
  let result: unknown;
  try {
    result = guard(event, context);
  } catch (thrown) {
    return Verdict.refuse(`${label} threw: ${describe(thrown)}`, FIX);
  }
  try {
    if (result instanceof Promise) return Verdict.refuse(`${label} returned a promise. Guards are synchronous and return a verdict`, FIX);
    const verdict = Verdict.parse(result);
    if (!verdict.ok) return Verdict.refuse(`${label} returned something that is not a verdict: ${verdict.error}`, FIX);
    return verdict.value.kind === "refuse" ? verdict.value : undefined;
  } catch (thrown) {
    return Verdict.refuse(`${label} returned something that cannot be read: ${describe(thrown)}`, FIX);
  }
}

function run(guards: readonly unknown[], event: unknown, context: unknown): Verdict {
  if (!Array.isArray(guards)) return Verdict.refuse("Dispatch was given guards that are not a list", "Pass the guards for this event as a list; with no guards, pass []");
  const checked = Event.parse(event);
  if (!checked.ok) return Verdict.refuse(`Dispatch was given an invalid event: ${checked.error}`, "Build the event with Event.parse, ToolUse.parse or SessionStart.parse");
  for (const [i, guard] of guards.entries()) {
    // Named by position: function names do not survive every bundler. Guards
    // receive the event they were given; it was checked above.
    const refusal = decide(guard, `Guard ${i + 1} of ${guards.length}`, event, context);
    if (refusal !== undefined) return refusal;
  }
  return Verdict.allow;
}

export const dispatch: Contract.Dispatch = (guards, event, ...context) => {
  try {
    return run(guards, event, context[0]);
  } catch (thrown) {
    return Verdict.refuse(`Dispatch could not finish: ${describe(thrown)}`, "Report this to the maintainers of bounded; the action is refused meanwhile");
  }
};
