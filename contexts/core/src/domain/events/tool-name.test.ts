import { describe, expect, test } from "bun:test";
import { ToolName } from "./tool-name.ts";


describe("ToolName — boundaries", () => {
  test("refuses a blank name, NUL and control characters, each with its reason", () => {
    expect(ToolName.parse(" ")).toEqual({ ok: false, error: "An invoke effect must name the tool it invokes" });
    expect(ToolName.parse("a\u0000b")).toEqual({ ok: false, error: "A tool name must not contain NUL or control characters" });
  });
});
