import { describeEffect } from "../events/effect.ts";
import type { Event } from "../events/event.contract.ts";
import type { Judgement } from "../guards/guard.contract.ts";
import type * as Contract from "./decision.contract.ts";

function verdictOf({ verdict, refusedBy }: Judgement): Contract.RecordedVerdict {
  if (verdict.kind === "allow") return Object.freeze({ kind: "allow" });
  return Object.freeze({
    kind: "refuse",
    reason: verdict.reason,
    redirect: verdict.redirect,
    pack: refusedBy === null ? null : refusedBy.pack,
    effect: refusedBy === null || refusedBy.effect === null ? null : describeEffect(refusedBy.effect),
  });
}

function of(time: string, event: Event, judgement: Judgement): Decision {
  const tool = event.kind === "tool-use" ? event : null;
  return Object.freeze({
    time,
    event: event.kind,
    role: event.role,
    tool: tool === null ? null : tool.tool,
    effects: Object.freeze(tool === null ? [] : tool.effects.map(describeEffect)),
    verdict: verdictOf(judgement),
  });
}

export type Decision = Contract.Decision;
export const Decision: Contract.DecisionFactory = { of };
