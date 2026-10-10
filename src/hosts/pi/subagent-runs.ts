// pi-subagents' runs as bounded sees them (ADR 2026-028): what a subagent
// result says of the run its one delegation started, the finish an async
// completion on pi's event bus reports, and which agent a later resume would
// revive. Everything pi-subagents gives is read without trusting it, and every
// reading fails closed: a result bounded cannot read or trust says its run's
// finish is never reported, and a run bounded cannot tie to an agent ties
// none. The shapes are pi-subagents 0.52.1's, read from its source.
import { AgentName, AgentRunId, type DelegatedAgentRunJSON } from "bounded/domain";

/** The channel pi-subagents emits each async run's completion on (src/shared/types.ts:1784). */
export const ASYNC_COMPLETE_CHANNEL = "subagent:async-complete";

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const own = (fields: Fields, name: string): unknown => (Object.hasOwn(fields, name) ? fields[name] : undefined);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
/** The flags pi-subagents sets on a run, or a child, that stopped before its end (src/runs/foreground/execution.ts, subagent-executor.ts). */
const STOPPED_EARLY = ["detached", "interrupted", "timedOut", "stopped", "turnBudgetExceeded"] as const;
const stoppedEarly = (fields: Fields): boolean => STOPPED_EARLY.some((flag) => own(fields, flag) === true);

const NEVER_REPORTED: DelegatedAgentRunJSON = { finished: false, finishNeverReported: true };

/** A subagent call's tool_result, as the extension read it from pi's event. */
export interface SubagentResult {
  /** The agents of the call's delegate effects, in order. */
  readonly delegatedAgents: readonly string[];
  /** Whether the call resumes a run. */
  readonly resume: boolean;
  /** pi's id for the call, from the event; undefined when it gave none. */
  readonly callId: string | undefined;
  /** The event's isError. */
  readonly isError: unknown;
  /** The event's details, as pi-subagents gave them. */
  readonly details: unknown;
  /** Whether pi-subagents' completions are observed: the extension subscribed on pi's event bus. */
  readonly completionsObserved: boolean;
}

/** What a result says of its one run: the entry for the core, and what bounded may remember of the run for a later resume. */
interface ResultReading {
  readonly entry: DelegatedAgentRunJSON;
  readonly remember?: { readonly kind: "launched"; readonly asyncId: string } | { readonly kind: "ran-to-end"; readonly agent: string };
}

/**
 * A launch's result (subagent-executor.ts:4387-4390): its run goes on, and its
 * completion names `asyncId`. Trusted only when the details are exactly a
 * workflow launch for this call: mode "workflow", the call's own id, no
 * results yet, and an id the core accepts, with completions observed.
 */
function launchReading(result: SubagentResult, details: Fields): ResultReading {
  const asyncId = own(details, "asyncId");
  const results = own(details, "results");
  const trusted =
    result.isError !== true &&
    own(details, "mode") === "workflow" &&
    result.callId !== undefined &&
    own(details, "toolCallId") === result.callId &&
    Array.isArray(results) &&
    results.length === 0 &&
    typeof asyncId === "string" &&
    AgentRunId.parse(asyncId).ok &&
    result.completionsObserved;
  if (!trusted || typeof asyncId !== "string") return { entry: NEVER_REPORTED };
  return { entry: { finished: false, agentRunId: asyncId, finishReportedLater: true }, remember: { kind: "launched", asyncId } };
}

/**
 * A foreground result (subagent-executor.ts:4492-4495, 4507-4511): its one
 * child ran to its end when the call is not an error, the child exited 0, and
 * no flag says it stopped early (a timed-out child exits 1; an interrupted one
 * exits 0 with `interrupted`, execution.ts:1343-1347). The agent it ran is
 * the child's `agent`, when it is a valid name.
 */
function foregroundReading(result: SubagentResult, details: Fields): ResultReading {
  const results = own(details, "results");
  if (!Array.isArray(results) || results.length !== 1) return { entry: NEVER_REPORTED };
  const [child] = results;
  if (!isFields(child)) return { entry: NEVER_REPORTED };
  const ranToEnd = result.isError !== true && own(child, "exitCode") === 0 && !stoppedEarly(child);
  if (!ranToEnd) return { entry: { finished: false } };
  const agent = own(child, "agent");
  const resolvedAgent = typeof agent === "string" && AgentName.parse(agent).ok ? agent : undefined;
  const entry: DelegatedAgentRunJSON = resolvedAgent === undefined ? { finished: true } : { finished: true, resolvedAgent };
  // Remembered for a resume only when pi-subagents named the run by this call's id and ran the agent the call asked for.
  const sameRun = result.callId !== undefined && own(details, "runId") === result.callId;
  return sameRun && resolvedAgent !== undefined && resolvedAgent === result.delegatedAgents[0] ? { entry, remember: { kind: "ran-to-end", agent: resolvedAgent } } : { entry };
}

/** What a subagent result says of the run its one delegation started, and what may be remembered of it. */
function readResult(result: SubagentResult): ResultReading | undefined {
  if (result.delegatedAgents.length === 0) return undefined;
  // Only a call with exactly one delegation, which is not a resume, is paired with a run (a resumed run never counts).
  if (result.delegatedAgents.length !== 1 || result.resume || !isFields(result.details)) return { entry: NEVER_REPORTED };
  return own(result.details, "asyncId") !== undefined ? launchReading(result, result.details) : foregroundReading(result, result.details);
}

/** The core's wire form of an agent run's finish (ADR 2026-025), as pi gives it. */
export interface AgentRunFinishedWire {
  readonly kind: "agent-run-finished";
  readonly role: null;
  readonly agent: string | null;
  readonly agentRunId: string | null;
  readonly ranToEnd: boolean;
}

/** What one completion says, copied out of its payload: the finish to record, if any, and what it tells of its run for a resume. */
export interface CompletionReading {
  /** The finish to record; undefined when the completion names no single child. */
  readonly finish?: AgentRunFinishedWire;
  /** The run id the completion names, when it is text. */
  readonly runId: string | null;
  /** The agent of its one child; null when it names no single child, or that child names no agent. */
  readonly agent: string | null;
}

/**
 * Reads a completion pi-subagents emitted (result-watcher.ts:559-577),
 * synchronously and into plain values, so nothing done to the payload later
 * changes what is recorded. It ran to its end only when the run's state is
 * "complete" and success true, its one child's success true and status
 * "completed", and no flag says the run or the child stopped early. Never
 * throws: a payload that cannot be read gives nothing.
 */
export function readCompletion(payload: unknown): CompletionReading {
  try {
    if (!isFields(payload)) return { runId: null, agent: null };
    const runId = text(own(payload, "runId"));
    const results = own(payload, "results");
    if (!Array.isArray(results) || results.length !== 1) return { runId, agent: null };
    const [child] = results;
    const childFields: Fields = isFields(child) ? child : {};
    const agent = text(own(childFields, "agent"));
    const ranToEnd =
      own(payload, "state") === "complete" &&
      own(payload, "success") === true &&
      isFields(child) &&
      own(child, "success") === true &&
      own(child, "status") === "completed" &&
      !stoppedEarly(payload) &&
      !stoppedEarly(child);
    return { finish: { kind: "agent-run-finished", role: null, agent, agentRunId: runId, ranToEnd }, runId, agent };
  } catch {
    return { runId: null, agent: null };
  }
}

/** A run bounded saw launched or run to its end, under every id that names it. */
interface ObservedRun {
  /** The agent the launching call asked for. */
  readonly agent: string;
  /** The run id its completion names; absent for a foreground run, which has none. */
  readonly asyncId?: string;
  tied: boolean;
  /** Set for good when a completion disagreed with the launch. */
  untiedForGood: boolean;
}

/**
 * The runs bounded saw in this pi session, in memory only (ADR 2026-028):
 * keyed only by ids bounded observed itself, an async launch's `asyncId` and
 * its call's id, and a foreground run's call id. A launch is tied to its agent
 * only when a completion for its `asyncId` names exactly one child, as that
 * agent; a completion that disagrees removes the tie for good. An entry is
 * never overwritten.
 */
export class ObservedSubagentRuns {
  readonly #byRunId = new Map<string, ObservedRun>();
  readonly #byAsyncId = new Map<string, ObservedRun>();

  /** The delegatedAgentRuns entries of a subagent result, remembering its run when it may later be resumed; undefined when the call delegated nothing. */
  delegatedAgentRuns(result: SubagentResult): DelegatedAgentRunJSON[] | undefined {
    const reading = readResult(result);
    if (reading === undefined) return undefined;
    const [agent] = result.delegatedAgents;
    const callId = result.callId;
    if (reading.remember !== undefined && agent !== undefined && callId !== undefined) {
      if (reading.remember.kind === "launched") this.#remember([reading.remember.asyncId, callId], { agent, asyncId: reading.remember.asyncId, tied: false, untiedForGood: false });
      else this.#remember([callId], { agent: reading.remember.agent, tied: true, untiedForGood: false });
    }
    return result.delegatedAgents.map(() => reading.entry);
  }

  /** What a completion tells of a launch bounded saw: it ties the launch's agent, or, disagreeing, unties it for good. */
  completed({ runId, agent }: CompletionReading): void {
    if (runId === null) return;
    const run = this.#byAsyncId.get(runId);
    if (run === undefined || run.untiedForGood) return;
    if (agent !== null && agent === run.agent) run.tied = true;
    else {
      run.tied = false;
      run.untiedForGood = true;
    }
  }

  /** The agent a resume naming `runId` revives, when bounded tied that run; otherwise undefined. */
  agentOf(runId: string): string | undefined {
    const run = this.#byRunId.get(runId);
    return run?.tied === true && !run.untiedForGood ? run.agent : undefined;
  }

  #remember(ids: readonly string[], run: ObservedRun): void {
    // Never overwritten: a later launch or result reusing an id leaves what was seen as it was.
    if (ids.some((id) => this.#byRunId.has(id)) || (run.asyncId !== undefined && this.#byAsyncId.has(run.asyncId))) return;
    for (const id of ids) this.#byRunId.set(id, run);
    if (run.asyncId !== undefined) this.#byAsyncId.set(run.asyncId, run);
  }
}
