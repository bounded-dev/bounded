import type { Result } from "../shared/result.ts";

/**
 * A place in a user-defined order, 0-based: a number that is a safe integer
 * and at least 0. -1, 1.5, NaN and Infinity are refused.
 * @accepts 0
 * @accepts 3
 */
export interface Position {
  readonly __brand: "Position";
  readonly value: number;
  equals(other: Position): boolean;
  toJSON(): number;
}

export interface PositionFactory {
  parse(raw: unknown): Result<Position>;
}
