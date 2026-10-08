import { describe, expect, test } from "bun:test";
import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { CallId } from "./call-id.ts";

const FORM = "A tool call id is non-empty text without control characters, at most 256 characters";

valueObjectLaws("CallId", CallId, ["toolu_1", "call/1:x"], ["", " ", "a\nb", "x".repeat(257)]);
textValueLaws("CallId", CallId, [["toolu_1", "toolu_1"], ["x".repeat(256), "x".repeat(256)]]);

describe("CallId — boundaries", () => {
  test("refuses blank, control-bearing or over-long text with one reason", () => {
    for (const raw of ["", " ", "a\u0000b", "x".repeat(257), 7]) expect(CallId.parse(raw)).toEqual({ ok: false, error: FORM });
  });
});
