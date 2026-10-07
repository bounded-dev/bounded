import type { Event } from "../events/event.contract.ts";
import type { Verdict } from "../verdicts/verdict.contract.ts";

/**
 * Decides one event. Synchronous and pure. `Context` is what the guard may
 * read besides the event: a placeholder for now (none, `void`), filled by
 * the composed result once guards become contributions.
 */
export type Guard<E extends Event, Context = void> = (event: E, context: Context) => Verdict;

/**
 * Runs the guards in the order given; the first refusal wins and later
 * guards do not run. No guards, or none refusing, allows. A guard that
 * throws, is not a function or returns anything but a verdict refuses,
 * naming the guard and the failure. Never throws.
 */
export type Dispatch = <E extends Event, Context = void>(guards: readonly Guard<E, Context>[], event: E, ...context: ContextArgument<Context>) => Verdict;

/** The context, when the guards take one; none when they take none. */
type ContextArgument<Context> = [Context] extends [void] ? [] : [context: Context];
