import { own, readSafely, show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { roleOf } from "./role.ts";
import type * as Contract from "./session-start.contract.ts";

function parse(raw: unknown): Result<SessionStart> {
  return readSafely("A session start", () => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "A session start is an object: { role }" };
    const kind = own(raw, "kind");
    if (kind !== undefined && kind !== "session-start") return { ok: false, error: `A session start has kind 'session-start', not '${show(kind)}'` };
    const role = roleOf(raw, "A session start");
    if (!role.ok) return role;
    // The brand exists only in types.
    return { ok: true, value: Object.freeze({ kind: "session-start", role: role.value }) as SessionStart };
  });
}

export type SessionStart = Contract.SessionStart;
export const SessionStart: Contract.SessionStartFactory = Object.freeze({ parse });
