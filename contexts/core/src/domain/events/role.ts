import { own } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./role.contract.ts";

// A branded string, as PackId: a role stays readable text in messages.
const LABEL = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function parse(raw: unknown): Result<Role> {
  if (typeof raw !== "string") return { ok: false, error: "A role must be a string" };
  if (!LABEL.test(raw)) return { ok: false, error: `Role '${raw}' must be lowercase words joined by single hyphens, such as 'builder'` };
  // The brand exists only in types; the checked text is the role.
  return { ok: true, value: raw as Role };
}

/** An event's role: a role label, or null when none is active. A missing role is refused, never read as none. */
export function roleOf(event: object, name: string): Result<Role | null> {
  const role = own(event, "role");
  if (role === undefined) return { ok: false, error: `${name} must name its role: a role label, or null when no role is active` };
  return role === null ? { ok: true, value: null } : parse(role);
}

export type Role = Contract.Role;
export const Role: Contract.RoleFactory = Object.freeze({ parse });
