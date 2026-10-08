import { describe, expect, test } from "bun:test";
import { commandMeaning } from "./command-meanings.ts";
import type { ShellWord } from "./shell-command.contract.ts";

const words = (...texts: string[]): ShellWord[] => texts.map((text) => ({ kind: "literal", text }));

describe("commandMeaning — what a command's name and words say it does", () => {
  test("cat reads its operands; rm deletes them; touch creates them if missing", () => {
    expect(commandMeaning("cat", words("a.ts")).reads).toEqual(words("a.ts"));
    expect(commandMeaning("rm", words("a.ts")).writes).toEqual([{ word: { kind: "literal", text: "a.ts" }, change: "delete" }]);
    expect(commandMeaning("touch", words("a.ts")).writes).toEqual([{ word: { kind: "literal", text: "a.ts" }, change: "create-if-missing" }]);
  });

  test("a command it does not know is taken to read its operands, and to write nothing", () => {
    expect(commandMeaning("frobnicate", words("a.ts"))).toMatchObject({ reads: words("a.ts"), lists: [], writes: [] });
  });
});
