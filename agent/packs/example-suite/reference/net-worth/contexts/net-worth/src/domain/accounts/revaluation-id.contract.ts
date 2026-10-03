import type { Result } from "../shared/result.ts";

/**
 * A revaluation's identity: a UUID (any version), matched case-insensitively
 * and held lower-cased. "revaluation-1" and "" are refused.
 * @accepts "6d7e8f9a-0b1c-4d2e-9f3a-4b5c6d7e8f9a"
 * @accepts "e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b"
 */
export interface RevaluationId {
  readonly __brand: "RevaluationId";
  readonly value: string;
  equals(other: RevaluationId): boolean;
  toJSON(): string;
}

export interface RevaluationIdFactory {
  generate(): RevaluationId;
  parse(raw: unknown): Result<RevaluationId>;
}
