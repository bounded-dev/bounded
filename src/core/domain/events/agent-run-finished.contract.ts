import type { Result } from "../shared/result.ts";
import type { AgentName } from "./agent-name.contract.ts";
import type { AgentRunId } from "./agent-run-id.contract.ts";
import type { Role } from "./role.contract.ts";

/** The brand only AgentRunFinished itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const agentRunFinishedBrand: unique symbol;

/**
 * An agent run finishing, as the host saw it (ADR 2026-025): an observation,
 * not an event the guards judge, since it has already happened. It names the
 * role of the session the host reports it in, the agent that ran as the host
 * resolved it, the run's id, and whether the run ran to its end (null when
 * the host does not say). It names no delegation, so any run with an id may
 * be its source. Built only by `AgentRunFinished.parse`.
 */
export interface AgentRunFinished {
  readonly __brand: "AgentRunFinished";
  readonly [agentRunFinishedBrand]: true;
  readonly kind: "agent-run-finished";
  readonly role: Role | null;
  readonly agent: AgentName;
  readonly agentRunId: AgentRunId;
  readonly ranToEnd: boolean | null;
  equals(other: AgentRunFinished): boolean;
  toJSON(): AgentRunFinishedJSON;
}

/** A finish's wire form (`kind` may be left out); every other field must be given. */
export interface AgentRunFinishedJSON {
  readonly kind?: "agent-run-finished";
  readonly role: string | null;
  readonly agent: string;
  readonly agentRunId: string;
  readonly ranToEnd: boolean | null;
}

export interface AgentRunFinishedFactory {
  /** A frozen finish from its wire form, or why the value is not one, naming the field. Never throws. */
  parse(raw: unknown): Result<AgentRunFinished>;
}
