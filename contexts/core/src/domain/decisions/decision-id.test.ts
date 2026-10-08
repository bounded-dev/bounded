import { describe, expect, test } from "bun:test";
import { DecisionId } from "./decision-id.ts";

const FORM = "A decision id is non-empty text without control characters, at most 256 characters";


describe("DecisionId — boundaries", () => {
  test("refuses blank, control-bearing or over-long text with one reason", () => {
    for (const raw of ["", "a\u0000b", "x".repeat(257), 1]) expect(DecisionId.parse(raw)).toEqual({ ok: false, error: FORM });
  });
});
