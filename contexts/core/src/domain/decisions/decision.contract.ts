import type { Event } from "../events/event.contract.ts";
import type { ToolResult } from "../events/tool-result.contract.ts";
import type { ToolKind } from "../events/tool-use.contract.ts";
import type { Judgement } from "../guards/guard.contract.ts";
import type { Verdict } from "../verdicts/verdict.contract.ts";

/** A decision's verdict as recorded: a refusal names the pack and effect that refused, when a pack did. */
export type RecordedVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "refuse"; readonly reason: string; readonly redirect: string; readonly pack: string | null; readonly effect: string | null };

/**
 * One decision on one event: plain, frozen, serialisable data for a decision
 * log. Every text field is at most 4,096 characters, longer text shortened
 * saying so. When two records share an id, the later one says what was
 * enforced (see `note`).
 */
export interface Decision {
  readonly id: string;
  /** When it was decided (or, for a follow-up, noted), ISO 8601 in UTC. */
  readonly time: string;
  /** The event's kind ("tool-result" after a tool ran), or "invalid" for an event that could not be read. */
  readonly event: Event["kind"] | ToolResult["kind"] | "invalid" | "adapter";
  readonly role: string | null;
  /** The tool kind of a tool use; null for a session start. */
  readonly tool: ToolKind | null;
  /** Each effect of a tool use, described ("write (modify) src/a.ts"); none for a session start. */
  readonly effects: readonly string[];
  readonly verdict: RecordedVerdict;
  /** Null for a decision; for a follow-up, why it supersedes the earlier record with its id. */
  readonly note: string | null;
  /** For a call the host adapter refused before the core saw an event: the host's tool name and a summary of its input. */
  readonly host?: { readonly tool: string; readonly input: string };
}

/** A call the host adapter refused itself, before it became an event. */
export interface AdapterRefusal {
  readonly role: string | null;
  readonly tool: string;
  readonly input: unknown;
  readonly verdict: Verdict;
}

export interface DecisionFactory {
  /** The decision `id` on `event`, judged as `judgement`, at `time`, with an optional note. */
  of(id: string, time: string, event: Event | ToolResult, judgement: Judgement, note?: string): Decision;
  /** The decision `id` on an event that could not be read: always a refusal. */
  invalid(id: string, time: string, refusal: Verdict): Decision;
  /** The decision `id` on a call the host adapter refused itself: always a refusal. */
  adapter(id: string, time: string, refusal: AdapterRefusal): Decision;
  /** A follow-up to `decision`, with its id: what was enforced instead, and why. */
  enforced(decision: Decision, time: string, verdict: Verdict, note: string): Decision;
}
