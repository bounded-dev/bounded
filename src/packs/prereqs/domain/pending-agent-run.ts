import type { pendingAgentRunBrand } from "./pending-agent-run.contract.ts";
import { AgentRunId, CallId, DecisionTime, own, type Result, readSafely, sameWire, wireFormOf } from "bounded/domain";
import type * as Contract from "./pending-agent-run.contract.ts";
import type { PrerequisiteStart as PrerequisiteStartType } from "./prerequisite-start.contract.ts";
import { hasExactly, PrerequisiteStart } from "./prerequisite-start.ts";

const WHAT = "A pending agent run";
const KEYS = ["agentRunId", "callId", "startedAt", "starts"];
const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** A pending run's fields once checked. */
interface Fields {
  readonly agentRunId: AgentRunId;
  readonly callId: CallId;
  readonly startedAt: DecisionTime;
  readonly starts: readonly [PrerequisiteStartType, ...PrerequisiteStartType[]];
}

function check(raw: unknown): Result<Fields> {
  if (!hasExactly(raw, KEYS)) return refuse(`${WHAT} is { agentRunId, callId, startedAt, starts }`);
  const agentRunId = AgentRunId.parse(own(raw, "agentRunId"));
  if (!agentRunId.ok) return refuse(`${WHAT}'s agentRunId: ${agentRunId.error}`);
  const callId = CallId.parse(own(raw, "callId"));
  if (!callId.ok) return refuse(`${WHAT}'s callId: ${callId.error}`);
  const startedAt = DecisionTime.parse(own(raw, "startedAt"));
  if (!startedAt.ok) return refuse(`${WHAT}'s startedAt: ${startedAt.error}`);
  const rawStarts = own(raw, "starts");
  if (!Array.isArray(rawStarts) || rawStarts.length === 0) return refuse(`${WHAT}'s starts are a non-empty list of prerequisite starts`);
  const starts = PrerequisiteStart.parseList(rawStarts);
  if (!starts.ok) return refuse(`${WHAT}'s starts: ${starts.error}`);
  const [first, ...rest] = starts.value;
  if (first === undefined) return refuse(`${WHAT}'s starts are a non-empty list of prerequisite starts`);
  return { ok: true, value: { agentRunId: agentRunId.value, callId: callId.value, startedAt: startedAt.value, starts: Object.freeze([first, ...rest] as const) } };
}

class PendingAgentRunImpl implements Contract.PendingAgentRun {
  declare readonly __brand: "PendingAgentRun";
  declare readonly [pendingAgentRunBrand]: true;
  readonly #made = true;
  readonly agentRunId: AgentRunId;
  readonly callId: CallId;
  readonly startedAt: DecisionTime;
  readonly starts: readonly [PrerequisiteStartType, ...PrerequisiteStartType[]];

  private constructor(fields: Fields) {
    this.agentRunId = fields.agentRunId;
    this.callId = fields.callId;
    this.startedAt = fields.startedAt;
    this.starts = fields.starts;
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is PendingAgentRunImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.PendingAgentRun> {
    return readSafely<Contract.PendingAgentRun>(WHAT, () => {
      const fields = check(PendingAgentRunImpl.made(raw) ? wireFormOf(raw) : raw);
      return fields.ok ? { ok: true, value: new PendingAgentRunImpl(fields.value) } : fields;
    });
  }

  equals(other: Contract.PendingAgentRun): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.PendingAgentRunJSON {
    return { agentRunId: this.agentRunId.value, callId: this.callId.value, startedAt: this.startedAt.value, starts: this.starts.map((start) => start.toJSON()) };
  }
}

export type PendingAgentRun = Contract.PendingAgentRun;
export const PendingAgentRun: Contract.PendingAgentRunFactory = PendingAgentRunImpl;
