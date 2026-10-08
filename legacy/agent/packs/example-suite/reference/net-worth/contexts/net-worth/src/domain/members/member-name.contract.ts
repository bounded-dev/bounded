import type { Result } from "../shared/result.ts";

/**
 * The display name of a member: a string that, once trimmed, is 1 to 80
 * characters long. The value is the trimmed string.
 * @accepts "Tim"
 * @accepts "Sarah"
 */
export interface MemberName {
  readonly __brand: "MemberName";
  readonly value: string;
  equals(other: MemberName): boolean;
  toJSON(): string;
  /** Whether two names collide for uniqueness: equal once both are lower-cased. */
  clashesWith(other: MemberName): boolean;
}

export interface MemberNameFactory {
  parse(raw: unknown): Result<MemberName>;
}
