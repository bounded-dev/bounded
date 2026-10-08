import { describe, expect, test } from "bun:test";
import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { Url } from "./url.ts";

valueObjectLaws("Url", Url, ["https://example.com/a", "mailto:someone@example.com"], ["example.com", "https://a b", "", "https://a\u0007"]);
textValueLaws("Url", Url, [["https://example.com/a", "https://example.com/a"]]);

describe("Url — boundaries", () => {
  test("refuses anything but an absolute URL with a scheme, naming it", () => {
    expect(Url.parse("example.com")).toEqual({ ok: false, error: "Fetch URL 'example.com' must be an absolute URL with a scheme, without spaces or control characters" });
    expect(Url.parse(3)).toEqual({ ok: false, error: "Fetch URL '3' must be an absolute URL with a scheme, without spaces or control characters" });
  });
});
