import type { Result } from "./result.ts";

/** A field of `raw`, only if it is its own: an inherited field is never read. */
export function own(raw: object, key: string): unknown {
  return Object.hasOwn(raw, key) ? (raw as Record<string, unknown>)[key] : undefined;
}

/** Text for any value, even one whose toString throws. */
export function show(value: unknown): string {
  try {
    return value instanceof Error ? value.message : String(value);
  } catch {
    return "a value that cannot be printed";
  }
}

/** Runs a parse; anything it throws (a getter, a proxy) becomes a refusal naming what could not be read. */
export function readSafely<T>(what: string, parse: () => Result<T>): Result<T> {
  try {
    return parse();
  } catch (thrown) {
    return { ok: false, error: `${what} could not be read: ${show(thrown)}` };
  }
}
