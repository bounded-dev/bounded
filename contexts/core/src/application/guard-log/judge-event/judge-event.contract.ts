import type { AdapterRefusalJSON, Decision, DecisionId, DecisionTime, Event, Result, Verdict } from "bounded/domain";

/** The brand only JudgeEventCommand itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const judgeEventCommandBrand: unique symbol;

// Wire input: the event's own wire form, checked by Event.parse.
export type JudgeEventInput = unknown;

// Command: the input once checked into an event.
export interface JudgeEventCommand {
  readonly __brand: "JudgeEventCommand";
  readonly [judgeEventCommandBrand]: true;
  readonly event: Event;
}

export interface JudgeEventCommandFactory {
  parse(raw: unknown): Result<JudgeEventCommand>;
}

// In port: what this feature offers.
/** Decide an event with the composed guards and record the decision; the verdict is what the host enforces. */
export interface JudgeEvent {
  execute(command: JudgeEventCommand): Promise<Verdict>;
  /** Judges an event in its wire form: one that cannot be read is refused and recorded as invalid. Never rejects. */
  judge(raw: unknown): Promise<Verdict>;
  /** Records a refusal the host adapter made itself, before an event existed, and returns it. Never rejects. */
  refuse(refusal: AdapterRefusalInput): Promise<Verdict>;
}

/** How a judge-event handler is set up, beyond its composition and out ports. */
export interface JudgeEventOptions {
  /** How long recording a decision may take before the event is refused. */
  readonly recordWithinMs?: number;
  /** When set, every event is refused with this verdict (a project whose configuration cannot be used). */
  readonly refuseEverything?: Verdict;
  readonly ids?: DecisionIds;
  /** Run when the guards allow an event, before it is recorded; a refusal replaces the allow. */
  readonly beforeAllow?: (event: Event) => Promise<Verdict>;
}

/** A refusal the host adapter made itself, in its wire form: the host's tool name, its input, the role, and the reason and redirect (read by AdapterRefusal.parse). */
export type AdapterRefusalInput = AdapterRefusalJSON;

// Out ports: exactly what this feature needs.
/**
 * Where decisions are kept, append-only. Asynchronous, so it can be a file
 * today and a remote service later.
 * @implementedBy FileSystemGuardLog
 */
export interface GuardLog {
  record(decision: Decision): Promise<void>;
}

/**
 * A new `DecisionId` for each decision, never the same twice. The handlers
 * still parse what it gives when a decision is recorded (ADR 2026-017).
 * @implementedBy RandomDecisionIds
 */
export interface DecisionIds {
  next(): DecisionId;
}

/**
 * The time of a decision, a `DecisionTime` (ISO 8601 in UTC). The handlers
 * still parse what it gives when a decision is recorded, so a host clock that
 * gives the ISO 8601 text is accepted with the same check (ADR 2026-017).
 * @implementedBy SystemClock
 */
export interface Clock {
  now(): DecisionTime;
}
