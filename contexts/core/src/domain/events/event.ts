import type { Result } from "../shared/result.ts";
import type * as Contract from "./event.contract.ts";
import { SessionStart } from "./session-start.ts";
import { ToolUse } from "./tool-use.ts";

function parse(raw: unknown): Result<Event> {
  const kind = typeof raw === "object" && raw !== null && "kind" in raw ? raw.kind : undefined;
  if (kind === "tool-use") return ToolUse.parse(raw);
  if (kind === "session-start") return SessionStart.parse(raw);
  return { ok: false, error: "An event has kind 'tool-use' or 'session-start'" };
}

export type Event = Contract.Event;
export const Event: Contract.EventFactory = { parse };
