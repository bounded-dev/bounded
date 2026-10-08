import { describe, expect, test } from "bun:test";
import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { DecisionId } from "./decision-id.ts";

const FORM = "A decision id is non-empty text without control characters, at most 256 characters";

valueObjectLaws("DecisionId", DecisionId, ["0b8e3f1a-2c4d-4e5f-9a6b-7c8d9e0f1a2b", "d-1"], ["", " ", "a\nb", "x".repeat(257)]);
textValueLaws("DecisionId", DecisionId, [["d-1", "d-1"]]);

describe("DecisionId — boundaries", () => {
  test("refuses blank, control-bearing or over-long text with one reason", () => {
    for (const raw of ["", "a\u0000b", "x".repeat(257), 1]) expect(DecisionId.parse(raw)).toEqual({ ok: false, error: FORM });
  });
});
