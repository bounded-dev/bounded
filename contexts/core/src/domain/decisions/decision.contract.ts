import type { Event } from "../events/event.contract.ts";
import type { ToolKind } from "../events/tool-use.contract.ts";
import type { Judgement } from "../guards/guard.contract.ts";

/** A decision's verdict as recorded: a refusal names the pack and effect that refused, when a pack did. */
export type RecordedVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "refuse"; readonly reason: string; readonly redirect: string; readonly pack: string | null; readonly effect: string | null };

/** One decision on one event: plain, frozen, serialisable data for a decision log. */
export interface Decision {
  /** When it was decided, ISO 8601 in UTC. */
  readonly time: string;
  readonly event: Event["kind"];
  readonly role: string | null;
  /** The tool kind of a tool use; null for a session start. */
  readonly tool: ToolKind | null;
  /** Each effect of a tool use, described ("write (modify) src/a.ts"); none for a session start. */
  readonly effects: readonly string[];
  readonly verdict: RecordedVerdict;
}

export interface DecisionFactory {
  /** The decision on `event`, judged as `judgement`, at `time`. */
  of(time: string, event: Event, judgement: Judgement): Decision;
}
