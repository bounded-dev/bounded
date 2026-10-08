import type { sessionStartBrand } from "./session-start.contract.ts";
import { own, readSafely, show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire, wireFormOf } from "../shared/wire.ts";
import type { Role } from "./role.contract.ts";
import { roleOf } from "./role.ts";
import type * as Contract from "./session-start.contract.ts";

class SessionStartImpl implements Contract.SessionStart {
  declare readonly __brand: "SessionStart";
  declare readonly [sessionStartBrand]: true;
  readonly #made = true;
  readonly kind = "session-start" as const;

  private constructor(readonly role: Role | null) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is SessionStartImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<SessionStart> {
    return readSafely("A session start", () => {
      if (SessionStartImpl.made(raw)) return SessionStartImpl.parse(wireFormOf(raw));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "A session start is an object: { role }" };
      const kind = own(raw, "kind");
      if (kind !== undefined && kind !== "session-start") return { ok: false, error: `A session start has kind 'session-start', not '${show(kind)}'` };
      const role = roleOf(raw, "A session start");
      return role.ok ? { ok: true, value: new SessionStartImpl(role.value) } : role;
    });
  }

  equals(other: SessionStart): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.SessionStartJSON {
    return { kind: this.kind, role: this.role === null ? null : this.role.value };
  }
}

export type SessionStart = Contract.SessionStart;
export const SessionStart: Contract.SessionStartFactory = SessionStartImpl;
