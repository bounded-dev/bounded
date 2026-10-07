import { describe, expect, test } from "bun:test";
import type { Result } from "./result.ts";

/**
 * The laws every value object obeys, whatever it accepts: each sample is
 * accepted; its wire form (JSON) parses back to an equal value; parsing a
 * parsed value gives it back unchanged; different samples give different
 * values; and anything refused, including values of the wrong type, is
 * refused with a reason.
 */
export function valueObjectLaws<T>(
  name: string,
  factory: { parse(raw: unknown): Result<T> },
  accepts: readonly [unknown, unknown, ...unknown[]],
  refuses: readonly unknown[],
): void {
  const parsed = (raw: unknown): T => {
    const result = factory.parse(raw);
    if (!result.ok) throw new Error(`${name} refused ${JSON.stringify(raw)}: ${result.error}`);
    return result.value;
  };

  describe(`${name} — laws`, () => {
    test("accepts every sample", () => {
      for (const raw of accepts) expect(factory.parse(raw).ok).toBe(true);
    });

    test("its wire form parses back to an equal value", () => {
      for (const raw of accepts) {
        const value = parsed(raw);
        expect(parsed(JSON.parse(JSON.stringify(value)))).toStrictEqual(value);
      }
    });

    test("parsing a parsed value gives it back unchanged", () => {
      for (const raw of accepts) {
        const value = parsed(raw);
        expect(parsed(value)).toStrictEqual(value);
      }
    });

    test("different samples give different values", () => {
      expect(parsed(accepts[0])).not.toEqual(parsed(accepts[1]));
    });

    test("refuses what it does not accept, with a reason", () => {
      for (const raw of [...refuses, undefined, null, 42, true, []]) {
        const result = factory.parse(raw);
        expect(result.ok).toBe(false);
        expect(!result.ok && result.error.length > 0).toBe(true);
      }
    });
  });
}
