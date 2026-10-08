import type { Result } from "../shared/result.ts";

/** The acting agent role's label, such as "builder": lowercase words joined by single hyphens. */
export interface Role {
  readonly __brand: "Role";
  readonly value: string;
  equals(other: Role): boolean;
  toJSON(): string;
}

export interface RoleFactory {
  /** A valid role, or why the value is not one. */
  parse(raw: unknown): Result<Role>;
}
