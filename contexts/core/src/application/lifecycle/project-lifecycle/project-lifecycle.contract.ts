import type { ToolResult, ToolUse, Verdict } from "bounded/domain";
import type { DecisionIds } from "../../guard-log/judge-event/judge-event.contract.ts";

// Out ports this feature shares with judge-event: declared there, listed here so this contract names every port the feature needs.
export type { Clock, DecisionIds, GuardLog } from "../../guard-log/judge-event/judge-event.contract.ts";

/** What the after-tool checks have to tell the agent: their messages joined, or null when none has one. */
export interface AfterToolOutcome {
  readonly message: string | null;
}

// In port: what this feature offers.
/** Run packs' asynchronous lifecycle checks around a tool call (the core pack's beforeTool and afterTool points). */
export interface ProjectLifecycle {
  /** Runs every beforeTool check in pack order; the first refusal wins; one that throws or answers with no verdict refuses, naming its pack. Never rejects. */
  before(call: ToolUse): Promise<Verdict>;
  /** Runs every afterTool check in pack order (all run); records each report's record; joins the messages with a blank line. Never rejects. */
  after(result: ToolResult): Promise<AfterToolOutcome>;
}

/** How a project-lifecycle handler is set up, beyond its composition, ports and out ports. */
export interface ProjectLifecycleOptions {
  readonly ids?: DecisionIds;
}
