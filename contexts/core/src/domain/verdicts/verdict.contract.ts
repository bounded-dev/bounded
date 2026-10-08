import type { Result } from "../shared/result.ts";

/** The brand only Verdict itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const verdictBrand: unique symbol;

/** Let the action happen. */
export interface Allow {
  readonly __brand: "Verdict";
  readonly [verdictBrand]: true;
  readonly kind: "allow";
  equals(other: Verdict): boolean;
  toJSON(): AllowJSON;
}

/** Refuse the action: why, and the permitted next step or owner. Both are non-empty, one line each. */
export interface Refuse {
  readonly __brand: "Verdict";
  readonly [verdictBrand]: true;
  readonly kind: "refuse";
  readonly reason: string;
  readonly redirect: string;
  equals(other: Verdict): boolean;
  toJSON(): RefuseJSON;
}

/** A guard's decision. Discriminated by `kind`, so a third form can be added later. */
export type Verdict = Allow | Refuse;

// Wire forms: what toJSON gives and Verdict.parse takes.
export interface AllowJSON {
  readonly kind: "allow";
}
export interface RefuseJSON {
  readonly kind: "refuse";
  readonly reason: string;
  readonly redirect: string;
}
export type VerdictJSON = AllowJSON | RefuseJSON;

export interface VerdictFactory {
  readonly allow: Allow;
  /** A refusal. Blank text is replaced by text that says what is missing: it still refuses. */
  refuse(reason: string, redirect: string): Refuse;
  /** A verdict from its wire form, or why the value is not one. */
  parse(raw: unknown): Result<Verdict>;
}
