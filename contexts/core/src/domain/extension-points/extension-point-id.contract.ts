import type { Result } from "../shared/result.ts";

/**
 * An extension point's id: dot-separated segments of lowercase words joined
 * by hyphens, unique across every selected pack.
 * @accepts "core.tool-use-guards"
 * @accepts "path-gate.protected-paths"
 */
export interface ExtensionPointId {
  readonly __brand: "ExtensionPointId";
  readonly value: string;
  equals(other: ExtensionPointId): boolean;
  toJSON(): string;
}

export interface ExtensionPointIdFactory {
  parse(raw: unknown): Result<ExtensionPointId>;
}
