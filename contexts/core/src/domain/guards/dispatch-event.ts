import type { Composition } from "../composition/composition.contract.ts";
import type { Effect } from "../events/effect.contract.ts";
import { describeEffect } from "../events/effect.ts";
import type { Event } from "../events/event.contract.ts";
import { Event as EventFactory } from "../events/event.ts";
import type { Result } from "../shared/result.ts";
import { Verdict } from "../verdicts/verdict.ts";
import { corePack } from "./core-pack.ts";
import { firstRefusal, invalidEvent, type LabelledGuard, unfinished } from "./dispatch.ts";

const CORE = corePack.id;
const { points } = corePack;

/** The guards contributed to `point`, labelled by the pack each came from. */
function labelled<V>(entries: Result<readonly { readonly from: string; readonly value: V }[]>, about: string): Result<LabelledGuard[]> {
  if (!entries.ok) return entries;
  const suffix = about === "" ? "" : ` ${about}`;
  return {
    ok: true,
    value: entries.value.map(({ from, value }) => ({ guard: value, label: `A guard from ${from}${about === "" ? "" : ` for ${about}`}`, refusedBy: `${from} refused${suffix}` })),
  };
}

function effectGuards(composition: Composition, effect: Effect): Result<LabelledGuard[]> {
  const about = describeEffect(effect);
  switch (effect.kind) {
    case "read":
      return labelled(composition.entries(points.readGuards), about);
    case "list":
      return labelled(composition.entries(points.listGuards), about);
    case "write":
      return labelled(composition.entries(points.writeGuards), about);
    case "execute":
      return labelled(composition.entries(points.executeGuards), about);
    case "fetch":
      return labelled(composition.entries(points.fetchGuards), about);
    case "delegate":
      return labelled(composition.entries(points.delegateGuards), about);
    case "invoke":
      return labelled(composition.entries(points.invokeGuards), about);
  }
}

function unreadable(error: string): Verdict {
  return Verdict.refuse(`The guards for this event cannot be read: ${error}`, "Select a single copy of the core pack with the packs that contribute guards");
}

/**
 * Decide an event with a composition's guards. A session start runs the
 * session-start guards. A tool use runs the whole-call guards, then each
 * effect in order through the guards for its kind; an effect kind with no
 * guards is allowed. Guards run in pack composition order (dependencies
 * first), then contribution order. The first refusal wins and names the pack
 * and, for an effect, the effect. Every failure refuses, including a
 * composition without the core pack. Never throws.
 */
export function dispatchEvent(composition: Composition, event: Event): Verdict {
  try {
    if (typeof composition !== "object" || composition === null || typeof composition.entries !== "function") {
      return Verdict.refuse("Dispatch was given something that is not a composition", "Compose the selected packs with Composition.compose and dispatch over the result");
    }
    const checked = EventFactory.parse(event);
    if (!checked.ok) return invalidEvent(checked.error);
    if (!composition.packs.includes(corePack)) {
      return Verdict.refuse(
        `No guards can be found: the core pack '${CORE}' is not selected, so nothing can decide this event`,
        `Select the core pack '${CORE}' with the packs that contribute guards; until then every event is refused`,
      );
    }
    const call = checked.value;
    if (call.kind === "session-start") {
      const starts = labelled(composition.entries(points.sessionStartGuards), "");
      return starts.ok ? (firstRefusal(starts.value, [call, composition]) ?? Verdict.allow) : unreadable(starts.error);
    }
    const whole = labelled(composition.entries(points.toolUseGuards), "");
    if (!whole.ok) return unreadable(whole.error);
    const refusal = firstRefusal(whole.value, [call, composition]);
    if (refusal !== undefined) return refusal;
    for (const effect of call.effects) {
      const guards = effectGuards(composition, effect);
      if (!guards.ok) return unreadable(guards.error);
      const refused = firstRefusal(guards.value, [effect, composition, call]);
      if (refused !== undefined) return refused;
    }
    return Verdict.allow;
  } catch (thrown) {
    return unfinished(thrown);
  }
}
