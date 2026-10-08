import type { Event } from "../events/event.contract.ts";
import { show } from "../shared/read.ts";
import { Verdict } from "../verdicts/verdict.ts";
import type * as Contract from "./dispatch.contract.ts";
import type { LabelledGuard } from "./dispatch.contract.ts";

const FIX = "Fix the guard so it returns Verdict.allow or Verdict.refuse(reason, redirect), or remove it. Until then the action is refused";
const UNFINISHED = "Report this to the maintainers of bounded; the action is refused meanwhile";

function decide({ run, label, refusedBy }: LabelledGuard): Verdict | undefined {
  let result: unknown;
  try {
    result = run();
  } catch (thrown) {
    return Verdict.refuse(`${label} threw: ${show(thrown)}`, FIX);
  }
  try {
    // A thenable is read like a promise: reading `then` may itself throw.
    if (typeof result === "object" && result !== null && typeof Reflect.get(result, "then") === "function") return Verdict.refuse(`${label} returned a promise. Guards are synchronous and return a verdict`, FIX);
    const verdict = Verdict.parse(result);
    if (!verdict.ok) return Verdict.refuse(`${label} returned something that is not a verdict: ${verdict.error}`, FIX);
    if (verdict.value.kind !== "refuse") return undefined;
    return refusedBy === undefined ? verdict.value : Verdict.refuse(`${refusedBy}: ${verdict.value.reason}`, verdict.value.redirect);
  } catch (thrown) {
    return Verdict.refuse(`${label} returned something that cannot be read: ${show(thrown)}`, FIX);
  }
}

/**
 * Runs guards in order; the first refusal wins, with the guard that made it,
 * or undefined when none refuses. Never throws.
 */
export function firstRefusal(guards: readonly LabelledGuard[]): { readonly verdict: Verdict; readonly by?: LabelledGuard } | undefined {
  try {
    for (const guard of guards) {
      const refusal = decide(guard);
      if (refusal !== undefined) return { verdict: refusal, by: guard };
    }
    return undefined;
  } catch (thrown) {
    return { verdict: unfinished(thrown) };
  }
}

let dispatching = false;

/**
 * Runs `run` unless a dispatch is already running: a guard that dispatches
 * again gets a short refusal instead of recursing until the stack overflows.
 */
export function outermost<T>(run: () => T, refused: (verdict: Verdict) => T): T {
  if (dispatching) {
    return refused(Verdict.refuse("Dispatch was called from inside a guard; guards decide events, they do not dispatch them", "Remove the call to dispatch from the guard"));
  }
  dispatching = true;
  try {
    return run();
  } finally {
    dispatching = false;
  }
}

/** The refusal when dispatch itself cannot finish. */
export function unfinished(thrown: unknown): Verdict {
  return Verdict.refuse(`Dispatch could not finish: ${show(thrown)}`, UNFINISHED);
}

export const dispatch: Contract.Dispatch = (guards, event, ...context) => outermost(() => run(guards, event, context[0]), (verdict) => verdict);

// The event is an Event, made by its class: frozen, normalised, vocabulary
// fields only. A guard is called whatever its value type, so one that is
// not a function refuses when its turn comes.
function run(guards: readonly unknown[], event: Event, context: unknown): Verdict {
  try {
    // Named by position: function names do not survive every bundler.
    const labelled = guards.map((guard, i): LabelledGuard => {
      const label = `Guard ${i + 1} of ${guards.length}`;
      return { run: () => (typeof guard === "function" ? guard(event, context) : Verdict.refuse(`${label} is not a function`, FIX)), label };
    });
    return firstRefusal(labelled)?.verdict ?? Verdict.allow;
  } catch (thrown) {
    return unfinished(thrown);
  }
}
