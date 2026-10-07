import type { Decision, Event, Result, Verdict } from "bounded/domain";

// Wire input: the event's own wire form, checked by Event.parse.
export type JudgeEventInput = unknown;

// Command: the input once checked into an event.
export interface JudgeEventCommand {
  readonly __brand: "JudgeEventCommand";
  readonly event: Event;
}

export interface JudgeEventCommandFactory {
  parse(raw: unknown): Result<JudgeEventCommand>;
}

// In port: what this feature offers.
/** Decide an event with the composed guards and record the decision; the verdict is what the host enforces. */
export interface JudgeEvent {
  execute(command: JudgeEventCommand): Promise<Verdict>;
}

// Out ports: exactly what this feature needs.
/**
 * Where decisions are kept, append-only. Asynchronous, so it can be a file
 * today and a remote service later.
 * @implementedBy in-memory file-system
 */
export interface DecisionLog {
  record(decision: Decision): Promise<void>;
}

/**
 * A new, unique id for each decision.
 * @implementedBy system
 */
export interface DecisionIds {
  next(): string;
}

/**
 * The time of a decision, ISO 8601 in UTC.
 * @implementedBy system
 */
export interface Clock {
  now(): string;
}
