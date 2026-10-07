import type { Result } from "../shared/result.ts";

/** The acting agent role's label, such as "builder". Branded, so a plain string cannot stand in for it. */
export type Role = string & { readonly __role: true };

export interface RoleFactory {
  /** A valid role, or why the value is not one. */
  parse(raw: unknown): Result<Role>;
}
