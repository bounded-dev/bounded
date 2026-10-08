import type { Result } from "../shared/result.ts";
import type { Refuse } from "../verdicts/verdict.contract.ts";

/** An adapter refusal's wire form: what a host adapter hands the core. */
export interface AdapterRefusalJSON {
  /** The host's own name for the tool it refused. */
  readonly hostToolName: string;
  readonly reason: string;
  readonly redirect: string;
  readonly role?: string | null;
  /** The tool call's input as the host gave it. */
  readonly input?: unknown;
}

/**
 * A call the host adapter refused itself, before it became an event (a path
 * outside the project, a call it cannot translate, a deadline): the host's
 * tool name, the call's input, the role, and the refusal.
 */
export interface AdapterRefusal {
  readonly __brand: "AdapterRefusal";
  readonly role: string | null;
  readonly hostToolName: string;
  readonly input: unknown;
  readonly verdict: Refuse;
  equals(other: AdapterRefusal): boolean;
  toJSON(): AdapterRefusalJSON;
}

export interface AdapterRefusalFactory {
  /**
   * A frozen adapter refusal from what a host adapter gave, read leniently,
   * since a refusal must be recorded whatever form it came in: the reason,
   * redirect and tool name as text (a missing tool name is 'unknown'), a
   * role that is not text as none. Refuses only what is not an object, or
   * cannot be read at all.
   */
  parse(raw: unknown): Result<AdapterRefusal>;
}
