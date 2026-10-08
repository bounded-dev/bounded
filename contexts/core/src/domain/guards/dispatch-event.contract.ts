import type { Composition } from "../composition/composition.contract.ts";
import type { Effect } from "../events/effect.contract.ts";
import type { Event } from "../events/event.contract.ts";
import type { PackId } from "../packs/pack-id.contract.ts";
import type { Verdict } from "../verdicts/verdict.contract.ts";

/** A verdict, and the pack (and effect) that refused when a pack's guard refused or failed. */
export interface Judgement {
  readonly verdict: Verdict;
  readonly refusedBy: { readonly packId: PackId; readonly effect: Effect | null } | null;
}

/**
 * Decides an event with a composition's guards: the core pack's whole-call
 * guards, then each effect's guards; the first refusal wins, attributed to
 * the pack (and effect) that refused. Takes a composition and an event as
 * their classes made them: untyped input is parsed before it reaches here,
 * and a composition Composition.compose did not make is refused. Never
 * throws.
 */
export type DecideEvent = (composition: Composition, event: Event) => Judgement;

/** DecideEvent's verdict alone. */
export type DispatchEvent = (composition: Composition, event: Event) => Verdict;
