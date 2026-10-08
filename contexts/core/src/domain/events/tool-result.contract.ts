import type { Result } from "../shared/result.ts";
import type { CallId } from "./call-id.contract.ts";
import type { Effect } from "./effect.contract.ts";
import type { Role } from "./role.contract.ts";
import type { ToolKind, ToolUseJSON } from "./tool-use.contract.ts";

/** The brand only ToolResult itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const toolResultBrand: unique symbol;

/**
 * What the host says, on a result, about the run one delegate effect started
 * (ADR 2026-019): whether that agent's run finished. Only a host that saw
 * the run end says true; a run returned at launch (a background run) is not
 * finished.
 */
export interface DelegatedAgentRun {
  readonly finished: boolean;
  /**
   * The host never reports when this agent's runs finish (pi with
   * pi-subagents, ADR 2026-019), so no run of it can be seen to finish: only
   * with `finished: false`; present only when true.
   */
  readonly finishNeverReported?: true;
}

/** A tool call that has run: the tool use, whether it succeeded, and its call id when the host gives one. */
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
  readonly delegatedAgentRuns?: readonly DelegatedAgentRun[];
}

export interface ToolResultFactory {
  /** A frozen tool result from its wire form, or why the value is not one. Checked like a tool use. */
  parse(raw: unknown): Result<ToolResult>;
}
