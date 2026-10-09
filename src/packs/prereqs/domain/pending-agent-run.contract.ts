import type { AgentRunId, CallId, DecisionTime, Result } from "bounded/domain";
import type { PrerequisiteStart, PrerequisiteStartJSON } from "./prerequisite-start.contract.ts";

/** The brand only PendingAgentRun itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const pendingAgentRunBrand: unique symbol;

/** A pending run's wire form: what the store keeps for a run between its launch and its finish. */
export interface PendingAgentRunJSON {
  readonly agentRunId: string;
  readonly callId: string;
  readonly startedAt: string;
  readonly starts: readonly PrerequisiteStartJSON[];
}

/**
 * A delegated run the host launched and whose finish it reports later
 * (ADR 2026-025): the run's id, the call that launched it, when the store saw
 * it start, and the starts of the requirements it may meet. Kept until its
 * finish, when the files are fingerprinted again.
 */
export interface PendingAgentRun {
  readonly __brand: "PendingAgentRun";
  readonly [pendingAgentRunBrand]: true;
  readonly agentRunId: AgentRunId;
  readonly callId: CallId;
  readonly startedAt: DecisionTime;
  readonly starts: readonly [PrerequisiteStart, ...PrerequisiteStart[]];
  equals(other: PendingAgentRun): boolean;
  toJSON(): PendingAgentRunJSON;
}

export interface PendingAgentRunFactory {
  /** A frozen pending run from its wire form, or why the value is not one, naming the field. Never throws. */
  parse(raw: unknown): Result<PendingAgentRun>;
}
