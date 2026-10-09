import { describe, expect, test } from "bun:test";
import { Url } from "./url.ts";


describe("Url — boundaries", () => {
  test("refuses anything but an absolute URL with a scheme, naming it", () => {
    expect(Url.parse("example.com")).toEqual({ ok: false, error: "Fetch URL 'example.com' must be an absolute URL with a scheme, without spaces or control characters" });
    expect(Url.parse(3)).toEqual({ ok: false, error: "Fetch URL '3' must be an absolute URL with a scheme, without spaces or control characters" });
  });
});
