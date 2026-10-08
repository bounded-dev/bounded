import type { roleBrand } from "./role.contract.ts";
import { own } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { wireFormOf } from "../shared/wire.ts";
import type * as Contract from "./role.contract.ts";

const LABEL = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

class RoleImpl implements Contract.Role {
  declare readonly __brand: "Role";
  declare readonly [roleBrand]: true;
  readonly #made = true;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is RoleImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Role> {
    if (RoleImpl.made(raw)) return RoleImpl.parse(wireFormOf(raw));
    if (typeof raw !== "string") return { ok: false, error: "A role must be a string" };
    if (!LABEL.test(raw)) return { ok: false, error: `Role '${raw}' must be lowercase words joined by single hyphens, such as 'builder'` };
    return { ok: true, value: new RoleImpl(raw) };
  }

  equals(other: Role): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type Role = Contract.Role;
export const Role: Contract.RoleFactory = RoleImpl;

/** An event's role: a role label, or null when none is active. A missing role is refused, never read as none. */
export function roleOf(event: object, name: string): Result<Role | null> {
  const role = own(event, "role");
  if (role === undefined) return { ok: false, error: `${name} must name its role: a role label, or null when no role is active` };
  return role === null ? { ok: true, value: null } : Role.parse(role);
}
