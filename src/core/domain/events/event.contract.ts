import type { Result } from "../shared/result.ts";
import type { SessionStart } from "./session-start.contract.ts";
import type { ToolUse } from "./tool-use.contract.ts";

/** What an agent is doing, in words no host owns: the vocabulary guards subscribe to. */
export type Event = ToolUse | SessionStart;

export interface EventFactory {
  /** An event of the kind its `kind` names, or why the value is not one. */
  parse(raw: unknown): Result<Event>;
}
