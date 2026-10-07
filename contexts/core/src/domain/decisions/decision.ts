import { describeEffect } from "../events/effect.ts";
import type { Event } from "../events/event.contract.ts";
import type { ToolResult } from "../events/tool-result.contract.ts";
import type { Judgement } from "../guards/guard.contract.ts";
import type { Verdict } from "../verdicts/verdict.contract.ts";
import type * as Contract from "./decision.contract.ts";

/** The longest text field a decision keeps. */
const LIMIT = 4096;
/** Text of at most LIMIT characters, counted and cut in code points so a character is never split. */
function bounded(text: string): string {
  const characters = [...text];
  return characters.length <= LIMIT ? text : `${characters.slice(0, LIMIT).join("")}… (shortened from ${characters.length} characters)`;
}

function verdictOf(verdict: Verdict, refusedBy: Judgement["refusedBy"]): Contract.RecordedVerdict {
  if (verdict.kind === "allow") return Object.freeze({ kind: "allow" });
  return Object.freeze({
    kind: "refuse",
    reason: bounded(verdict.reason),
    redirect: bounded(verdict.redirect),
    pack: refusedBy === null ? null : refusedBy.pack,
    effect: refusedBy === null || refusedBy.effect === null ? null : bounded(describeEffect(refusedBy.effect)),
  });
}

function of(id: string, time: string, event: Event | ToolResult, judgement: Judgement, note?: string): Decision {
  const tool = event.kind === "session-start" ? null : event;
  return Object.freeze({
    id: bounded(id),
    time: bounded(time),
    event: event.kind,
    role: event.role,
    tool: tool === null ? null : tool.tool,
    effects: Object.freeze(tool === null ? [] : tool.effects.map((effect) => bounded(describeEffect(effect)))),
    verdict: verdictOf(judgement.verdict, judgement.refusedBy),
    note: note === undefined ? null : bounded(note),
  });
}

function enforced(decision: Decision, time: string, verdict: Verdict, note: string): Decision {
  return Object.freeze({ ...decision, time: bounded(time), verdict: verdictOf(verdict, null), note: bounded(note) });
}

function invalid(id: string, time: string, refusal: Verdict): Decision {
  return Object.freeze({ id: bounded(id), time: bounded(time), event: "invalid", role: null, tool: null, effects: Object.freeze([]), verdict: verdictOf(refusal, null), note: null });
}

export type Decision = Contract.Decision;
export const Decision: Contract.DecisionFactory = Object.freeze({ of, invalid, enforced });
