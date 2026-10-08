import type { agentNameBrand } from "./agent-name.contract.ts";
import type { Result } from "../shared/result.ts";
import { wireFormOf } from "../shared/wire.ts";
import { hasControl } from "../shared/text.ts";
import type * as Contract from "./agent-name.contract.ts";

class AgentNameImpl implements Contract.AgentName {
  declare readonly __brand: "AgentName";
  declare readonly [agentNameBrand]: true;
  readonly #made = true;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is AgentNameImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<AgentName> {
    if (AgentNameImpl.made(raw)) return AgentNameImpl.parse(wireFormOf(raw));
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
