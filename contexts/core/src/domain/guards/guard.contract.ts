import type { Effect } from "../events/effect.contract.ts";
import type { Event } from "../events/event.contract.ts";
import type { ToolUse } from "../events/tool-use.contract.ts";
import type { PackId } from "../packs/pack-id.contract.ts";
import type { Verdict } from "../verdicts/verdict.contract.ts";

/**
 * Decides one event. Synchronous and pure. `Context` is what the guard may
 * read besides the event: a placeholder, filled by the composed result once
 * guards become contributions. Every guard is given it; a guard that does
 * not need it is a `Guard<E>`, which takes it as `unknown`, so it sits in
 * any list.
 */
export type Guard<E extends Event, Context = unknown> = (event: E, context: Context) => Verdict;

/** A verdict, and the pack (and effect) that refused when a pack's guard refused or failed. */
export interface Judgement {
  readonly verdict: Verdict;
  readonly refusedBy: { readonly packId: PackId; readonly effect: Effect | null } | null;
}

/**
 * Decides one effect of a tool call: given the effect, the context and the
 * whole call (for its role and tool). Synchronous and pure. A guard for one
 * effect kind cannot serve another kind's point.
 */
export type EffectGuard<F extends Effect, Context = unknown> = (effect: F, context: Context, call: ToolUse) => Verdict;

/**
 * Runs the guards in the order given; the first refusal wins and later
 * guards do not run. No guards, or none refusing, allows. A guard that
 * throws, is not a function or returns anything but a verdict refuses,
 * naming the guard and the failure. Never throws.
 */
export type Dispatch = <E extends Event, Context = unknown>(guards: readonly Guard<E, Context>[], event: E, ...context: ContextArgument<Context>) => Verdict;

/** The context: required when a guard needs a particular one, optional when none does. */
type ContextArgument<Context> = unknown extends Context ? [context?: Context] : [context: Context];
