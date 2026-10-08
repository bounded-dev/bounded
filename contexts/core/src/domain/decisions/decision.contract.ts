import type { AdapterRefusal } from "./adapter-refusal.contract.ts";
import type { Event } from "../events/event.contract.ts";
import type { ToolResult } from "../events/tool-result.contract.ts";
import type { ToolKind } from "../events/tool-use.contract.ts";
import type { Judgement } from "../guards/dispatch-event.contract.ts";
import type { Result } from "../shared/result.ts";
import type { Verdict } from "../verdicts/verdict.contract.ts";
import type { DecisionId } from "./decision-id.contract.ts";

/** The brand only Decision itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const decisionBrand: unique symbol;

/** A decision's verdict as recorded: a refusal names the pack and effect that refused, when a pack did. */
export type RecordedVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "refuse"; readonly reason: string; readonly redirect: string; readonly pack: string | null; readonly effect: string | null };

/** What a decision records about its event: its kind ("tool-result" after a tool ran), "invalid" for an event that could not be read, "adapter" for a call the host adapter refused. */
export type DecisionEvent = Event["kind"] | ToolResult["kind"] | "invalid" | "adapter";

/**
 * One decision on one event, for a guard log: its record is text, as it
 * was decided. Every text field is at most 4,096 characters, longer text
 * shortened saying so. When two records share an id, the later one says what
 * was enforced (see `note`), so a decision is a value, not an entity.
 */
export interface Decision {
  readonly __brand: "Decision";
  readonly [decisionBrand]: true;
  readonly id: DecisionId;
  /** When it was decided (or, for a follow-up, noted), ISO 8601 in UTC. */
  readonly time: string;
  readonly event: DecisionEvent;
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
  equals(other: Decision): boolean;
  toJSON(): DecisionJSON;
}

/** A decision as one line of a guard log. */
export interface DecisionJSON {
  readonly id: string;
  readonly time: string;
  readonly event: DecisionEvent;
  readonly role: string | null;
  readonly tool: ToolKind | null;
  readonly effects: readonly string[];
  readonly verdict: RecordedVerdict;
  readonly note: string | null;
  readonly host?: { readonly tool: string; readonly input: string };
}

export interface DecisionFactory {
  /** The decision `id` on `event`, judged as `judgement`, at `time`, with an optional note. */
  of(id: DecisionId, time: string, event: Event | ToolResult, judgement: Judgement, note?: string): Decision;
  /** The decision `id` on an event that could not be read: always a refusal. */
  invalid(id: DecisionId, time: string, refusal: Verdict): Decision;
  /** The decision `id` on a call the host adapter refused itself: always a refusal. */
  adapter(id: DecisionId, time: string, refusal: AdapterRefusal): Decision;
  /** A follow-up to `decision`, with its id: what was enforced instead, and why. */
  enforced(decision: Decision, time: string, verdict: Verdict, note: string): Decision;
  /** A decision from a recorded line, or why the value is not one. */
  parse(raw: unknown): Result<Decision>;
}
