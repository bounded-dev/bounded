import type { OpenedProject, ToolResult, ToolUse, Verdict } from "bounded/domain";
import type { DecisionIds } from "../../bounded-log/judge-event/judge-event.contract.ts";

// Out ports this feature shares with judge-event: declared there, listed here so this contract names every port the feature needs.
export type { Clock, DecisionIds, BoundedLog } from "../../bounded-log/judge-event/judge-event.contract.ts";

/** What the after-tool checks have to tell the agent: their messages joined, or null when none has one. */
export interface AfterToolOutcome {
  readonly message: string | null;
}

// In port: what this feature offers.
/** Run packs' asynchronous lifecycle work: when a project opens, and around each tool call (the core pack's onProjectOpen, beforeTool and afterTool points). */
export interface ProjectLifecycle {
  /** Runs every onProjectOpen handler, all at once; one that fails, or runs out of time, is let go: the pack's own guards answer for it. Never rejects. */
  open(project: OpenedProject): Promise<void>;
  /** Runs every beforeTool check in pack order; the first refusal wins; one that throws or answers with no verdict refuses, naming its pack. Never rejects. */
  before(call: ToolUse): Promise<Verdict>;
  /** Runs every afterTool check in pack order (all run); records each report's record; joins the messages with a blank line. Never rejects. */
  after(result: ToolResult): Promise<AfterToolOutcome>;
}

/** How a project-lifecycle handler is set up, beyond its composition, ports and out ports. */
export interface ProjectLifecycleOptions {
  readonly ids?: DecisionIds;
  /** How long each pack's work on opening may take before the project opens without it. */
  readonly prepareWithinMs?: number;
}
