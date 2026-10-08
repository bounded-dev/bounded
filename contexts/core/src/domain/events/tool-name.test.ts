import { describe, expect, test } from "bun:test";
import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { ToolName } from "./tool-name.ts";

valueObjectLaws("ToolName", ToolName, ["mcp__docs__search", "web_search"], ["", " ", "a\u0000b"]);
textValueLaws("ToolName", ToolName, [["mcp__docs__search", "mcp__docs__search"]]);

describe("ToolName — boundaries", () => {
  test("refuses a blank name, NUL and control characters, each with its reason", () => {
    expect(ToolName.parse(" ")).toEqual({ ok: false, error: "An invoke effect must name the tool it invokes" });
    expect(ToolName.parse("a\u0000b")).toEqual({ ok: false, error: "A tool name must not contain NUL or control characters" });
  });
});
