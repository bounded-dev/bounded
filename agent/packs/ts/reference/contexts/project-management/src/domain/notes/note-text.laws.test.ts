// GENERATED from note-text.contract.ts by packs/ts/scripts/value-object-laws.ts — do not edit.
import { describe, expect, test } from "bun:test";
import type { Result } from "../shared/result.ts";
import { NoteText } from "./note-text.ts";

/** Inputs no value of this type may accept, labelled so a failing law names them. */
const HOSTILE_INPUTS: readonly (readonly [string, unknown])[] = [
  ["undefined", undefined],
  ["null", null],
  ["true", true],
  ["false", false],
  ["0", 0],
  ["-1", -1],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["[]", []],
  ["{}", {}],
  ["() => {}", () => {}],
  ["Symbol(\"x\")", Symbol("x")],
  ["new Date()", new Date()],
  ["9007199254740993n", 9007199254740993n],
];

/** The value a parse produced, or a failure naming the refused example. A
 *  throwing skeleton never reaches this line: its NotImplementedError
 *  propagates first, which is what the red gate looks for. */
function mustParse<T>(result: Result<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} was refused: ${String(result.error)}`);
  return result.value;
}

describe("NoteText — value-object laws (generated)", () => {
  test("parse refuses every hostile input", () => {
    const wronglyAccepted = HOSTILE_INPUTS.filter(([, raw]) => NoteText.parse(raw).ok).map(([label]) => label);
    expect(wronglyAccepted).toEqual([]);
  });

  test("parse gives a reason for every refusal", () => {
    const silent = HOSTILE_INPUTS.filter(([, raw]) => {
      const result = NoteText.parse(raw);
      return !result.ok && !(typeof result.error === "string" && result.error.trim() !== "");
    }).map(([label]) => label);
    expect(silent).toEqual([]);
  });

  test("parse accepts the contract's @accepts examples", () => {
    expect(NoteText.parse("Call the printer").ok).toBe(true);
    expect(NoteText.parse("Book the venue").ok).toBe(true);
  });

  test("toJSON is the string wire form", () => {
    expect(typeof mustParse(NoteText.parse("Call the printer"), "NoteText.parse(\"Call the printer\")").toJSON()).toBe("string");
  });

  test("toJSON round-trips through parse", () => {
    const a = mustParse(NoteText.parse("Call the printer"), "NoteText.parse(\"Call the printer\")");
    const back = mustParse(NoteText.parse(a.toJSON()), "NoteText.parse(toJSON())");
    expect(back.equals(a)).toBe(true);
    expect(back.toJSON()).toStrictEqual(a.toJSON());
  });

  test("parses deterministically", () => {
    const a = mustParse(NoteText.parse("Call the printer"), "NoteText.parse(\"Call the printer\")");
    expect(mustParse(NoteText.parse(a.toJSON()), "NoteText.parse(toJSON())").toJSON()).toStrictEqual(mustParse(NoteText.parse(a.toJSON()), "NoteText.parse(toJSON())").toJSON());
  });

  test("equals is reflexive", () => {
    const a = mustParse(NoteText.parse("Call the printer"), "NoteText.parse(\"Call the printer\")");
    expect(a.equals(a)).toBe(true);
  });

  test("equals compares by value, not by reference", () => {
    const a = mustParse(NoteText.parse("Call the printer"), "NoteText.parse(\"Call the printer\")");
    const b = mustParse(NoteText.parse(a.toJSON()), "NoteText.parse(toJSON())");
    expect(a.equals(b)).toBe(true);
    expect(b.equals(a)).toBe(true);
  });

  test("equals discriminates two different values", () => {
    const a = mustParse(NoteText.parse("Call the printer"), "NoteText.parse(\"Call the printer\")");
    const other = mustParse(NoteText.parse("Book the venue"), "NoteText.parse(\"Book the venue\")");
    expect(a.equals(other)).toBe(false);
    expect(other.equals(a)).toBe(false);
  });
});
