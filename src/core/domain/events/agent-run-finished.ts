import type { agentRunFinishedBrand } from "./agent-run-finished.contract.ts";
import { own, readSafely, show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire, wireFormOf } from "../shared/wire.ts";
import { AgentName } from "./agent-name.ts";
import type * as Contract from "./agent-run-finished.contract.ts";
import { AgentRunId } from "./agent-run-id.ts";
import type { Role } from "./role.contract.ts";
import { roleOf } from "./role.ts";

const WHAT = "An agent run's finish";

/** A finish's fields once checked. */
interface Fields {
  readonly role: Role | null;
  readonly agent: AgentName;
  readonly agentRunId: AgentRunId;
  readonly ranToEnd: boolean | null;
}

class AgentRunFinishedImpl implements Contract.AgentRunFinished {
  declare readonly __brand: "AgentRunFinished";
  declare readonly [agentRunFinishedBrand]: true;
  readonly #made = true;
  readonly kind = "agent-run-finished" as const;
  readonly role: Role | null;
  readonly agent: AgentName;
  readonly agentRunId: AgentRunId;
  readonly ranToEnd: boolean | null;

  private constructor(fields: Fields) {
    this.role = fields.role;
    this.agent = fields.agent;
    this.agentRunId = fields.agentRunId;
    this.ranToEnd = fields.ranToEnd;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is AgentRunFinishedImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.AgentRunFinished> {
    return readSafely<Contract.AgentRunFinished>(WHAT, () => {
      if (AgentRunFinishedImpl.made(raw)) return AgentRunFinishedImpl.parse(wireFormOf(raw));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: `${WHAT} is an object: { role, agent, agentRunId, ranToEnd }` };
      const kind = own(raw, "kind");
      if (kind !== undefined && kind !== "agent-run-finished") return { ok: false, error: `${WHAT} has kind 'agent-run-finished', not '${show(kind)}'` };
      const role = roleOf(raw, WHAT);
      if (!role.ok) return role;
      const agent = AgentName.parse(own(raw, "agent"));
      if (!agent.ok) return { ok: false, error: `${WHAT}'s agent: ${agent.error}` };
      const agentRunId = AgentRunId.parse(own(raw, "agentRunId"));
      if (!agentRunId.ok) return { ok: false, error: `${WHAT}'s agentRunId: ${agentRunId.error}` };
      const ranToEnd = own(raw, "ranToEnd");
      if (ranToEnd !== true && ranToEnd !== false && ranToEnd !== null) return { ok: false, error: `${WHAT} says whether it ran to its end: ranToEnd is true, false or null` };
      return { ok: true, value: new AgentRunFinishedImpl({ role: role.value, agent: agent.value, agentRunId: agentRunId.value, ranToEnd }) };
    });
  }

  equals(other: Contract.AgentRunFinished): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.AgentRunFinishedJSON {
    return { kind: this.kind, role: this.role === null ? null : this.role.value, agent: this.agent.value, agentRunId: this.agentRunId.value, ranToEnd: this.ranToEnd };
  }
}

export type AgentRunFinished = Contract.AgentRunFinished;
export const AgentRunFinished: Contract.AgentRunFinishedFactory = AgentRunFinishedImpl;
