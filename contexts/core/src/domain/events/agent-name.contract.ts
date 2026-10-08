import type { Result } from "../shared/result.ts";

/** The agent a delegate effect hands work to, as the host names it: not blank, without control characters. */
export interface AgentName {
  readonly __brand: "AgentName";
  readonly value: string;
  equals(other: AgentName): boolean;
  toJSON(): string;
}

export interface AgentNameFactory {
  /** A valid agentName, or why the value is not one. */
  parse(raw: unknown): Result<AgentName>;
}
