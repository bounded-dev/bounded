import { describe, expect, test } from "bun:test";
import { Command } from "./command.ts";


describe("Command — boundaries", () => {
  test("a command is kept exactly as given; tabs and line breaks are allowed", () => {
    const result = Command.parse("a\r\nb\tc");
    expect(result.ok && result.value.value).toBe("a\r\nb\tc");
  });

  test("refuses a blank command, NUL and other control characters, each with its reason", () => {
    expect(Command.parse(" ")).toEqual({ ok: false, error: "An execute effect must name the command it runs" });
    expect(Command.parse("rm a\0b")).toEqual({ ok: false, error: "A command must not contain a NUL character" });
    expect(Command.parse("echo \u001b[31m")).toEqual({ ok: false, error: "A command must not contain control characters other than tab and line breaks" });
  });
});
