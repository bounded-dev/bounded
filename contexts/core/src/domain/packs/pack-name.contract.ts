import type { Result } from "../shared/result.ts";

/**
 * A pack's name: lowercase words joined by single hyphens. Nothing else is a
 * name, so no name can reach outside the folder that holds the packs.
 * @accepts "core"
 * @accepts "path-gate"
 */
export interface PackName {
  readonly __brand: "PackName";
  readonly value: string;
  equals(other: PackName): boolean;
  toJSON(): string;
}

export interface PackNameFactory {
  parse(raw: unknown): Result<PackName>;
}
