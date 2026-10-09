import type { Result } from "../shared/result.ts";

/** The brand only AgentName itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const agentNameBrand: unique symbol;

/** The agent a delegate effect hands work to, as the host names it: not blank, without control characters. */
export interface AgentName {
  readonly __brand: "AgentName";
  readonly [agentNameBrand]: true;
  readonly value: string;
  equals(other: AgentName): boolean;
  toJSON(): string;
}

export interface AgentNameFactory {
  /** A valid agentName, or why the value is not one. */
  parse(raw: unknown): Result<AgentName>;
}
