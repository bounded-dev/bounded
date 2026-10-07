import type { Result } from "../shared/result.ts";

/** Let the action happen. */
export interface Allow {
  readonly __brand: "Verdict";
  readonly kind: "allow";
}

/** Refuse the action: why, and the permitted next step or owner. Both are non-empty. */
export interface Refuse {
  readonly __brand: "Verdict";
  readonly kind: "refuse";
  readonly reason: string;
  readonly redirect: string;
}

/** A guard's decision. Discriminated by `kind`, so a third form can be added later. */
export type Verdict = Allow | Refuse;

export interface VerdictFactory {
  readonly allow: Allow;
  /** A refusal. Blank text is replaced by text that says what is missing: it still refuses. */
  refuse(reason: string, redirect: string): Refuse;
  /** A verdict from its wire form, or why the value is not one. */
  parse(raw: unknown): Result<Verdict>;
}
