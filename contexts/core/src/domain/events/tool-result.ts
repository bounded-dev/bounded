import { own, readSafely, show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./tool-result.contract.ts";
import { ToolUse } from "./tool-use.ts";

function check(raw: unknown): Result<ToolResult> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "A tool result is an object: { role, tool, effects, ok, callId? }" };
  const kind = own(raw, "kind");
  if (kind !== undefined && kind !== "tool-result") return { ok: false, error: `A tool result has kind 'tool-result', not '${show(kind)}'` };
  const ok = own(raw, "ok");
  if (typeof ok !== "boolean") return { ok: false, error: "A tool result says whether the tool succeeded: ok is true or false" };
  const callId = own(raw, "callId");
  // The rest is a tool use's, checked the same way.
  const call = ToolUse.parse({ role: own(raw, "role"), tool: own(raw, "tool"), effects: own(raw, "effects"), ...(callId === undefined ? {} : { callId }) });
  if (!call.ok) return call;
  const { role, tool, effects } = call.value;
  const fields = { kind: "tool-result", role, tool, effects, ok };
  // The brand exists only in types.
  return { ok: true, value: Object.freeze(call.value.callId === undefined ? fields : { ...fields, callId: call.value.callId }) as ToolResult };
}

const parse = (raw: unknown): Result<ToolResult> => readSafely("A tool result", () => check(raw));

export type ToolResult = Contract.ToolResult;
export const ToolResult: Contract.ToolResultFactory = Object.freeze({ parse });
