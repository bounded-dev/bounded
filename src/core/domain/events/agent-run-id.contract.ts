import type { Result } from "../shared/result.ts";

/** The brand only AgentRunId itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const agentRunIdBrand: unique symbol;

/**
 * The host's id for one delegated agent run: non-empty text without control
 * characters, at most 256 characters. A result that launches a run and the
 * run's finish name the same id (ADR 2026-025).
 */
export interface AgentRunId {
  readonly __brand: "AgentRunId";
  readonly [agentRunIdBrand]: true;
  readonly value: string;
  equals(other: AgentRunId): boolean;
  toJSON(): string;
}

export interface AgentRunIdFactory {
  /** A valid agent run id, or why the value is not one. */
  parse(raw: unknown): Result<AgentRunId>;
}
