import type { Result } from "../shared/result.ts";

/**
 * A member's identity: a UUID (any version), matched case-insensitively and
 * held lower-cased. "member-1" and "" are refused.
 * @accepts "2a9d6c1b-7e3f-4a5b-9c8d-1e2f3a4b5c6d"
 * @accepts "c4e8a2f6-1b3d-4e5f-8a7b-9c0d1e2f3a4b"
 */
export interface MemberId {
  readonly __brand: "MemberId";
  readonly value: string;
  equals(other: MemberId): boolean;
  toJSON(): string;
}

export interface MemberIdFactory {
  generate(): MemberId;
  parse(raw: unknown): Result<MemberId>;
}
