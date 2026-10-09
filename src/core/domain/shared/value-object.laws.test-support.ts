import { describe, expect, test } from "bun:test";
import type { Result } from "./result.ts";

/** What every value object is, as in the worked example: a class instance, equal by value, with a wire form. */
export interface ValueObject<T> {
  readonly __brand: string;
  equals(other: T): boolean;
  toJSON(): unknown;
}

/** A value's wire form, as another process reads it: its JSON, parsed. */
export const wireOf = (value: unknown): unknown => JSON.parse(JSON.stringify(value) ?? "null");

/**
 * The laws every value object obeys, whatever it accepts: each sample is
 * accepted; its wire form (JSON) parses back to an equal value; parsing a
 * parsed value gives it back unchanged; different samples give different
 * values; and anything refused, including values of the wrong type, is
 * refused with a reason. As in the worked example, each value is an instance
 * of its class, never a plain object, frozen, equal by value through
 * `equals`, and `toJSON` gives the wire form `parse` takes back.
 */
export function valueObjectLaws<T extends ValueObject<T>>(
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

    test("each value is an instance of its class, not a plain object, and frozen", () => {
      for (const raw of accepts) {
        const value = parsed(raw);
        expect(Object.getPrototypeOf(value)).not.toBe(Object.prototype);
        expect(Object.isFrozen(value)).toBe(true);
      }
    });

    test("equal by value: the same sample parsed twice is equal, different samples are not", () => {
      for (const raw of accepts) expect(parsed(raw).equals(parsed(raw))).toBe(true);
      expect(parsed(accepts[0]).equals(parsed(accepts[1]))).toBe(false);
    });

    test("toJSON is its wire form: plain data that parses back to an equal value", () => {
      for (const raw of accepts) {
        const value = parsed(raw);
        const json = value.toJSON();
        expect(json).toEqual(wireOf(value));
        expect(value.equals(parsed(json))).toBe(true);
      }
    });

    test("an object that merely inherits from a value is never taken for it", () => {
      for (const raw of accepts) {
        const forged: unknown = Object.create(parsed(raw));
        const result = factory.parse(forged);
        expect(result.ok && result.value === forged).toBe(false);
      }
    });

    test("a value forged with its class's own constructor is checked again, never trusted", () => {
      // The private constructor is TypeScript's only: at run time it can be called.
      const made = Object.getPrototypeOf(parsed(accepts[0])).constructor as new (...args: unknown[]) => unknown;
      for (const raw of refuses) {
        let forged: unknown;
        try {
          forged = Reflect.construct(made, [raw, raw, raw, raw, raw, raw]);
        } catch {
          continue; // a constructor that cannot be given junk makes nothing to forge with
        }
        const result = factory.parse(forged);
        expect(result.ok && result.value === forged).toBe(false);
        // A text value forged from refused text is refused, as that text is.
        if (typeof raw === "string" && wireOf(forged) === raw) expect(result.ok).toBe(false);
      }
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

/**
 * The laws of a value object holding one piece of text: `value` is the text
 * it was parsed from (or that text normalised), and its wire form is that
 * text, so JSON written before value objects were classes reads the same.
 */
export function textValueLaws<T extends ValueObject<T> & { readonly value: string }>(
  name: string,
  factory: { parse(raw: unknown): Result<T> },
  samples: readonly (readonly [raw: string, value: string])[],
): void {
  describe(`${name} — a text value`, () => {
    test("value is what was parsed", () => {
      for (const [raw, value] of samples) {
        const result = factory.parse(raw);
        expect(result.ok && result.value.value).toBe(value);
      }
    });

    test("its wire form is its text", () => {
      for (const [raw, value] of samples) {
        const result = factory.parse(raw);
        expect(result.ok && result.value.toJSON()).toBe(value);
        expect(result.ok && JSON.stringify(result.value)).toBe(JSON.stringify(value));
      }
    });
  });
}
