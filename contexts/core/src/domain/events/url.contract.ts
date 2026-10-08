import type { Result } from "../shared/result.ts";

/** The brand only Url itself carries: an object literal cannot, so a look-alike does not type-check (ADR 2026-012). Never exported from a barrel. */
export declare const urlBrand: unique symbol;

/** The URL a fetch effect reaches: absolute, with a scheme, without spaces or control characters. */
export interface Url {
  readonly __brand: "Url";
  readonly [urlBrand]: true;
  readonly value: string;
  equals(other: Url): boolean;
  toJSON(): string;
}

export interface UrlFactory {
  /** A valid url, or why the value is not one. */
  parse(raw: unknown): Result<Url>;
}
