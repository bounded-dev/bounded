import type { Composition, Entry } from "../composition/composition.contract.ts";
import type { Effect, EffectByKind, EffectKind } from "../events/effect.contract.ts";
import { describeEffect } from "../events/effect.ts";
import type { Event } from "../events/event.contract.ts";
import { isComposition } from "../composition/composition.ts";
import { Event as EventFactory } from "../events/event.ts";
import type { ToolUse } from "../events/tool-use.contract.ts";
import type { Result } from "../shared/result.ts";
import { Verdict } from "../verdicts/verdict.ts";
import type * as Contract from "./dispatch-event.contract.ts";
import type { Judgement } from "./dispatch-event.contract.ts";
import type { LabelledGuard } from "./dispatch.contract.ts";
import { corePack } from "./core-pack.ts";
import { firstRefusal, invalidEvent, outermost, unfinished } from "./dispatch.ts";

const CORE = corePack.id.value;
const { points } = corePack;

/** Guards contributed to a point, labelled by the pack each came from, each run by `run` with its arguments. */
function labelled<G>(entries: Result<readonly Entry<G>[]>, about: string, run: (guard: G) => unknown): Result<LabelledGuard[]> {
  if (!entries.ok) return entries;
  const suffix = about === "" ? "" : ` ${about}`;
  return {
    ok: true,
    value: entries.value.map(({ fromPackId, value }) => ({
      run: () => run(value),
      label: `A guard from ${fromPackId.value}${about === "" ? "" : ` for ${about}`}`,
      refusedBy: `${fromPackId.value} refused${suffix}`,
      from: fromPackId,
    })),
  };
}

/** The guards for one effect: the point for its kind, found by lookup, each guard called with the effect at its kind's type. */
function effectGuards<K extends EffectKind>(composition: Composition, kind: K, effect: EffectByKind[K], call: ToolUse): Result<LabelledGuard[]> {
  return labelled(composition.entries(points.effectGuards[kind]), describeEffect(effect), (guard) => guard(effect, composition, call));
}

function unreadable(error: string): Verdict {
  return Verdict.refuse(`The guards for this event cannot be read: ${error}`, "Select a single copy of the core pack with the packs that contribute guards");
}

/** A refusal no pack made. */
const plain = (verdict: Verdict): Judgement => ({ verdict, refusedBy: null });

/** A judgement from the first refusal of some guards, attributing it to its pack and effect. */
function judged(refusal: ReturnType<typeof firstRefusal>, effect: Effect | null): Judgement | undefined {
  if (refusal === undefined) return undefined;
  const packId = refusal.by?.from;
  return { verdict: refusal.verdict, refusedBy: packId === undefined ? null : { packId, effect } };
}

/**
 * Decide an event with a composition's guards. A session start runs the
 * session-start guards. A tool use runs the whole-call guards, then each
 * effect in order through the guards for its kind; an effect kind with no
 * guards is allowed. Guards run in pack composition order (dependencies
 * first), then contribution order. The first refusal wins and names the pack
 * and, for an effect, the effect; the judgement also says which pack and
 * effect refused. Every failure refuses, including a composition without the
 * core pack. Never throws.
 */
export const decideEvent: Contract.DecideEvent = (composition, event) => outermost(() => decide(composition, event), (verdict) => plain(verdict));

function decide(composition: Composition | null, event: Event): Judgement {
  try {
    if (!isComposition(composition)) {
      return plain(Verdict.refuse("Dispatch was given something that is not a composition", "Compose the selected packs with Composition.compose and dispatch over the result"));
    }
    const checked = EventFactory.parse(event);
    if (!checked.ok) return plain(invalidEvent(checked.error));
    if (!composition.packs.includes(corePack)) {
      return plain(
        Verdict.refuse(
          `No guards can be found: the core pack '${CORE}' is not selected, so nothing can decide this event`,
          `Select the core pack '${CORE}' with the packs that contribute guards; until then every event is refused`,
        ),
      );
    }
    const call = checked.value;
    if (call.kind === "session-start") {
      const starts = labelled(composition.entries(points.sessionStartGuards), "", (guard) => guard(call, composition));
      if (!starts.ok) return plain(unreadable(starts.error));
      return judged(firstRefusal(starts.value), null) ?? plain(Verdict.allow);
    }
    const whole = labelled(composition.entries(points.toolUseGuards), "", (guard) => guard(call, composition));
    if (!whole.ok) return plain(unreadable(whole.error));
    const refusal = judged(firstRefusal(whole.value), null);
    if (refusal !== undefined) return refusal;
    for (const effect of call.effects) {
      const guards = effectGuards(composition, effect.kind, effect, call);
      if (!guards.ok) return plain(unreadable(guards.error));
      const refused = judged(firstRefusal(guards.value), effect);
      if (refused !== undefined) return refused;
    }
    return plain(Verdict.allow);
  } catch (thrown) {
    return plain(unfinished(thrown));
  }
}

/** The verdict of `decideEvent`: what a host adapter needs. Never throws. */
export const dispatchEvent: Contract.DispatchEvent = (composition, event) => decideEvent(composition, event).verdict;
