import { describe, expect, test } from "bun:test";
import { dispatch } from "../guards/dispatch.ts";
import { ToolUse } from "../events/tool-use.ts";
import { show } from "./read.ts";

function errorWithMessage(message: unknown): Error {
  const error = new Error("placeholder");
  Object.defineProperty(error, "message", { value: message });
  return error;
}
const unprintable = { toString: () => { throw new Error("no"); } };

describe("show", () => {
  test("is text for an error whose message is a symbol, or an object that cannot be printed", () => {
    expect(show(errorWithMessage(Symbol("odd")))).toBe("Symbol(odd)");
    expect(show(errorWithMessage(unprintable))).toBe("a value that cannot be printed");
    expect(show(unprintable)).toBe("a value that cannot be printed");
    expect(show(new Error("plain"))).toBe("plain");
  });

  test("keeps dispatch total when a guard throws such an error", () => {
    const event = ToolUse.parse({ role: null, tool: "edit", effects: [{ kind: "write", path: "a.ts", change: "modify" }] });
    if (!event.ok) throw new Error(event.error);
    const throwing = () => {
      throw errorWithMessage(unprintable);
    };
    const verdict = dispatch([throwing as never], event.value);
    expect(verdict.kind).toBe("refuse");
    expect(verdict.kind === "refuse" && verdict.reason).toBe("Guard 1 of 1 threw: a value that cannot be printed");
  });
});
