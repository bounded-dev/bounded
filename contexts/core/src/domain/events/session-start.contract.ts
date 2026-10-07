import type { Result } from "../shared/result.ts";
import type { Role } from "./role.contract.ts";

/** A session starting, as a role or with none. Built only by `SessionStart.parse`. */
export interface SessionStart {
  readonly __brand: "SessionStart";
  readonly kind: "session-start";
  readonly role: Role | null;
}

export interface SessionStartFactory {
  /** A frozen session start from its wire form, or why the value is not one. */
  parse(raw: unknown): Result<SessionStart>;
}
