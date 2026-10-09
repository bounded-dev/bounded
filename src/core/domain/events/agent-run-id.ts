import type { agentRunIdBrand } from "./agent-run-id.contract.ts";
import type { Result } from "../shared/result.ts";
import { wireFormOf } from "../shared/wire.ts";
import { hasControl } from "../shared/text.ts";
import type * as Contract from "./agent-run-id.contract.ts";

class AgentRunIdImpl implements Contract.AgentRunId {
  declare readonly __brand: "AgentRunId";
  declare readonly [agentRunIdBrand]: true;
  readonly #made = true;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is AgentRunIdImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<AgentRunId> {
    if (AgentRunIdImpl.made(raw)) return AgentRunIdImpl.parse(wireFormOf(raw));
    if (typeof raw !== "string" || raw.trim() === "" || raw.length > 256 || hasControl(raw)) {
      return { ok: false, error: "An agent run id is non-empty text without control characters, at most 256 characters" };
    }
    return { ok: true, value: new AgentRunIdImpl(raw) };
  }

  equals(other: AgentRunId): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type AgentRunId = Contract.AgentRunId;
export const AgentRunId: Contract.AgentRunIdFactory = AgentRunIdImpl;
