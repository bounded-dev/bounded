import { describe, expect, test } from "bun:test";
import { CHARGE_EVERY, expandBraces, TOO_COSTLY } from "./brace-expansion.ts";

describe("expandBraces: what a pass is charged, and where it looks at the time", () => {
  test("a pass is charged its length, then nothing every CHARGE_EVERY characters, each a chance to stop; its words come with whether the text is also left to the shell", () => {
    const text = `{${"a".repeat(3 * CHARGE_EVERY)}`;
    const charges: number[] = [];
    expect(
      expandBraces(text, (steps) => {
        charges.push(steps);
        return true;
      }),
    ).toEqual({ words: [text], alsoUnresolved: false });
    expect(charges).toEqual([text.length + 1, 0, 0, 0]);
    // Refusing at a check inside the pass stops it there.
    for (const refusedAt of [2, 3, 4]) {
      let calls = 0;
      expect(expandBraces(text, () => ++calls < refusedAt)).toBe(TOO_COSTLY);
      expect(calls).toBe(refusedAt);
    }
  });

  test("text with no brace is not charged, and is its one word", () => {
    let calls = 0;
    expect(expandBraces("a".repeat(3 * CHARGE_EVERY), () => ++calls > 0)).toEqual({ words: ["a".repeat(3 * CHARGE_EVERY)], alsoUnresolved: false });
    expect(calls).toBe(0);
  });

  test("a range's words and a kept group arrive escaped, so a later pass never expands them; nothing is left to the shell", () => {
    expect(expandBraces("f{1..3..2}{a,b}", () => true)).toEqual({ words: ["f1a", "f1b", "f3a", "f3b", "f\\{1\\.\\.3\\.\\.2\\}a", "f\\{1\\.\\.3\\.\\.2\\}b"], alsoUnresolved: false });
  });

  test("a plus-signed group is sliced however long, expanded every way the recorded shells do, and its pass charged", () => {
    // Recorded (ADR 2026-020): f{+01..03} gives f1 f2 f3 in /bin/bash 3.2.57 (the number read, neither padded nor stepped), f001 f002
    // f003 in bash 5.3.20 (padded to the written width, the sign included), and stays f{+01..03} in zsh 5.9.
    const zeros = "0".repeat(60);
    const text = `{+${zeros}1..2}`;
    const charges: number[] = [];
    const expanded = expandBraces(text, (steps) => {
      charges.push(steps);
      return true;
    });
    const padded = (value: number): string => String(value).padStart(62, "0");
    expect(expanded).toEqual({ words: ["1", "2", padded(1), padded(2), `\\{+${zeros}1\\.\\.2\\}`], alsoUnresolved: false });
    expect(charges[0]).toBe(text.length + 1);
  });
});
