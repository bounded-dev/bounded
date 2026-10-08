import type { Result } from "../shared/result.ts";

/** The brand only Role itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const roleBrand: unique symbol;

/** The acting agent role's label, such as "builder": lowercase words joined by single hyphens. */
export interface Role {
  readonly __brand: "Role";
  readonly [roleBrand]: true;
  readonly value: string;
  equals(other: Role): boolean;
  toJSON(): string;
}

export interface RoleFactory {
  /** A valid role, or why the value is not one. */
  parse(raw: unknown): Result<Role>;
}
