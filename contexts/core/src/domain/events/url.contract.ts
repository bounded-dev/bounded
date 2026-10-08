import type { Result } from "../shared/result.ts";

/** The URL a fetch effect reaches: absolute, with a scheme, without spaces or control characters. */
export interface Url {
  readonly __brand: "Url";
  readonly value: string;
  equals(other: Url): boolean;
  toJSON(): string;
}

export interface UrlFactory {
  /** A valid url, or why the value is not one. */
  parse(raw: unknown): Result<Url>;
}
