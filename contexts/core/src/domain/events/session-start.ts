import type { Result } from "../shared/result.ts";
import type * as Contract from "./session-start.contract.ts";
import { roleOf } from "./role.ts";

function parse(raw: unknown): Result<SessionStart> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "A session start is an object: { role }" };
  if ("kind" in raw && raw.kind !== undefined && raw.kind !== "session-start") {
    return { ok: false, error: `A session start has kind 'session-start', not '${String(raw.kind)}'` };
  }
  const role = roleOf(raw, "A session start");
  if (!role.ok) return role;
  // The brand exists only in types.
  return { ok: true, value: Object.freeze({ kind: "session-start", role: role.value }) as SessionStart };
}

export type SessionStart = Contract.SessionStart;
export const SessionStart: Contract.SessionStartFactory = { parse };
