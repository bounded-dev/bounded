import type { Result } from "../shared/result.ts";
import { hasControl } from "../shared/text.ts";
import type * as Contract from "./agent-name.contract.ts";

class AgentNameImpl implements Contract.AgentName {
  declare readonly __brand: "AgentName";
  readonly #made = true;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse trusts it as it is. */
  static made(raw: unknown): raw is AgentNameImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<AgentName> {
    if (AgentNameImpl.made(raw)) return { ok: true, value: raw };
    if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "A delegate effect must name the agent it delegates to" };
    if (hasControl(raw)) return { ok: false, error: "An agent's name must not contain control characters" };
    return { ok: true, value: new AgentNameImpl(raw) };
  }

  equals(other: AgentName): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type AgentName = Contract.AgentName;
export const AgentName: Contract.AgentNameFactory = AgentNameImpl;
