import { describe, expect, test } from "bun:test";
import { NamePattern } from "./name-pattern.ts";


describe("NamePattern — boundaries", () => {
  test("refuses blank text with the list filter's reason", () => {
    expect(NamePattern.parse(" ")).toEqual({ ok: false, error: "A list's filter is a non-empty file-name pattern, or null" });
  });
});
