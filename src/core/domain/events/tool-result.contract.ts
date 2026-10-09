import type { Result } from "../shared/result.ts";
import type { AgentName } from "./agent-name.contract.ts";
import type { AgentRunId } from "./agent-run-id.contract.ts";
import type { CallId } from "./call-id.contract.ts";
import type { Effect } from "./effect.contract.ts";
import type { Role } from "./role.contract.ts";
import type { ToolKind, ToolUseJSON } from "./tool-use.contract.ts";

/** The brand only ToolResult itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const toolResultBrand: unique symbol;

/**
 * What the host says, on a result, about the run one delegate effect started
 * (ADR 2026-019, ADR 2026-025): whether that agent's run finished. Only a
 * host that saw the run end says true; a run returned at launch (a background
 * run) is not finished. Each optional field is present only when the host
 * says it.
 */
export interface DelegatedAgentRun {
  readonly finished: boolean;
  /**
   * The host never reports when this agent's runs finish (pi with
   * pi-subagents, ADR 2026-019), so no run of it can be seen to finish: only
   * with `finished: false`; present only when true.
   */
  readonly finishNeverReported?: true;
  /** The run's id, when the host gives one: its finish, reported later, names the same id. */
  readonly agentRunId?: AgentRunId;
  /**
   * This run goes on after this result, and the host reports its finish
   * later, as an agent run's finish with this `agentRunId`: only with
   * `finished: false` and an `agentRunId`, never with `finishNeverReported`.
   */
  readonly finishReportedLater?: true;
  /** The agent the host actually ran, as it resolved the requested name (the delegate effect's agent stays the requested one). */
  readonly resolvedAgent?: AgentName;
}

/** A delegated run's entry as written: its ids and names as text, each optional field only when given. */
export interface DelegatedAgentRunJSON {
  readonly finished: boolean;
  readonly finishNeverReported?: true;
  readonly agentRunId?: string;
  readonly finishReportedLater?: true;
  readonly resolvedAgent?: string;
}

/**
 * A tool call that has run: the tool use, whether it succeeded, and its call
 * id when the host gives one. Its execute effects carry a reading, as a tool
 * use's do (ADR 2026-020): the host adapter reads the command again after the
 * call, so the result's reading may differ from the call's (the files it
 * named may now exist).
 */
export interface ToolResult {
  readonly __brand: "ToolResult";
  readonly [toolResultBrand]: true;
  readonly kind: "tool-result";
  readonly role: Role | null;
  readonly toolKind: ToolKind;
  readonly effects: readonly [Effect, ...Effect[]];
  readonly callId?: CallId;
  readonly ok: boolean;
  /** One entry per delegate effect, in the effects' order, when the host says; absent, no run is said to have finished. */
  readonly delegatedAgentRuns?: readonly DelegatedAgentRun[];
  equals(other: ToolResult): boolean;
  toJSON(): ToolResultJSON;
}

/** A tool result's wire form: a tool use's, with kind "tool-result", whether it succeeded, and what the host says of each delegated run. */
export interface ToolResultJSON extends Omit<ToolUseJSON, "kind"> {
  readonly kind?: "tool-result";
  readonly ok: boolean;
  /** Written by toJSON only when given. */
  readonly delegatedAgentRuns?: readonly DelegatedAgentRunJSON[];
}

export interface ToolResultFactory {
  /** A frozen tool result from its wire form, or why the value is not one. Checked like a tool use. */
  parse(raw: unknown): Result<ToolResult>;
}
