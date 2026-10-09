import { describe, expect, test } from "bun:test";
import { CHARGE_EVERY, expandBraces, TOO_COSTLY } from "./brace-expansion.ts";

describe("expandBraces: what a pass is charged, and where it looks at the time", () => {
  test("a pass is charged its length, then nothing every CHARGE_EVERY characters, each a chance to stop", () => {
    const text = `{${"a".repeat(3 * CHARGE_EVERY)}`;
    const charges: number[] = [];
    expect(
      expandBraces(text, (steps) => {
        charges.push(steps);
        return true;
      }),
    ).toEqual([text]);
    expect(charges).toEqual([text.length + 1, 0, 0, 0]);
    // Refusing at a check inside the pass stops it there.
    for (const refusedAt of [2, 3, 4]) {
      let calls = 0;
      expect(expandBraces(text, () => ++calls < refusedAt)).toBe(TOO_COSTLY);
      expect(calls).toBe(refusedAt);
    }
  });

  test("text with no brace is not charged", () => {
    let calls = 0;
    expect(expandBraces("a".repeat(3 * CHARGE_EVERY), () => ++calls > 0)).toEqual(["a".repeat(3 * CHARGE_EVERY)]);
    expect(calls).toBe(0);
  });

  test("a range's words and a kept group arrive escaped, so a later pass never expands them", () => {
    expect(expandBraces("f{1..3..2}{a,b}", () => true)).toEqual(["f1a", "f1b", "f3a", "f3b", "f\\{1\\.\\.3\\.\\.2\\}a", "f\\{1\\.\\.3\\.\\.2\\}b"]);
  });
});
