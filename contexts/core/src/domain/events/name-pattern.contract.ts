import type { Result } from "../shared/result.ts";

/** The brand only NamePattern itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const namePatternBrand: unique symbol;

/** The file-name pattern a list effect is limited to, such as '*.ts': non-empty text, kept as given. */
export interface NamePattern {
  readonly __brand: "NamePattern";
  readonly [namePatternBrand]: true;
  readonly value: string;
  equals(other: NamePattern): boolean;
  toJSON(): string;
}

export interface NamePatternFactory {
  /** A valid namePattern, or why the value is not one. */
  parse(raw: unknown): Result<NamePattern>;
}
