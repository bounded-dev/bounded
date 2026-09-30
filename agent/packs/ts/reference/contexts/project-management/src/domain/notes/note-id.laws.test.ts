// GENERATED from note-id.contract.ts by packs/ts/scripts/value-object-laws.ts — do not edit.
import { describe, expect, test } from "bun:test";
import type { Result } from "../shared/result.ts";
import { NoteId } from "./note-id.ts";

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

describe("NoteId — identifier laws (generated)", () => {
  test("parse refuses every hostile input", () => {
    const wronglyAccepted = HOSTILE_INPUTS.filter(([, raw]) => NoteId.parse(raw).ok).map(([label]) => label);
    expect(wronglyAccepted).toEqual([]);
  });

  test("parse gives a reason for every refusal", () => {
    const silent = HOSTILE_INPUTS.filter(([, raw]) => {
      const result = NoteId.parse(raw);
      return !result.ok && !(typeof result.error === "string" && result.error.trim() !== "");
    }).map(([label]) => label);
    expect(silent).toEqual([]);
  });

  test("toJSON is the string wire form", () => {
    expect(typeof NoteId.generate().toJSON()).toBe("string");
  });

  test("toJSON round-trips through parse", () => {
    const a = NoteId.generate();
    const back = mustParse(NoteId.parse(a.toJSON()), "NoteId.parse(toJSON())");
    expect(back.equals(a)).toBe(true);
    expect(back.toJSON()).toStrictEqual(a.toJSON());
  });

  test("parses deterministically", () => {
    const a = NoteId.generate();
    expect(mustParse(NoteId.parse(a.toJSON()), "NoteId.parse(toJSON())").toJSON()).toStrictEqual(mustParse(NoteId.parse(a.toJSON()), "NoteId.parse(toJSON())").toJSON());
  });

  test("equals is reflexive", () => {
    const a = NoteId.generate();
    expect(a.equals(a)).toBe(true);
  });

  test("equals compares by value, not by reference", () => {
    const a = NoteId.generate();
    const b = mustParse(NoteId.parse(a.toJSON()), "NoteId.parse(toJSON())");
    expect(a.equals(b)).toBe(true);
    expect(b.equals(a)).toBe(true);
  });

  test("equals discriminates two different values", () => {
    const a = NoteId.generate();
    const other = NoteId.generate();
    expect(a.equals(other)).toBe(false);
    expect(other.equals(a)).toBe(false);
  });

  test("generate yields distinct identifiers", () => {
    expect(NoteId.generate().equals(NoteId.generate())).toBe(false);
  });
});
