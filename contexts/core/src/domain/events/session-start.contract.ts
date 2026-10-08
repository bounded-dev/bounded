import type { Result } from "../shared/result.ts";
import type { Role } from "./role.contract.ts";

/** The brand only SessionStart itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const sessionStartBrand: unique symbol;

/** A session starting, as a role or with none. Built only by `SessionStart.parse`. */
export interface SessionStart {
  readonly __brand: "SessionStart";
  readonly [sessionStartBrand]: true;
  readonly kind: "session-start";
  readonly role: Role | null;
  equals(other: SessionStart): boolean;
  toJSON(): SessionStartJSON;
}

/** A session start's wire form (`kind` may be left out). */
export interface SessionStartJSON {
  readonly kind?: "session-start";
  readonly role: string | null;
}

export interface SessionStartFactory {
  /** A frozen session start from its wire form, or why the value is not one. */
  parse(raw: unknown): Result<SessionStart>;
}
