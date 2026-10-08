import { describe, expect, test } from "bun:test";
import { commandMeaning } from "./command-meanings.ts";
import type { ShellWord } from "./shell-command.contract.ts";

const words = (...texts: string[]): ShellWord[] => texts.map((text) => ({ kind: "literal", text }));

describe("read by bounded's shell command reader — commandMeaning — what a command's name and words say it does", () => {
  test("cat reads its operands; rm deletes them; touch creates them if missing", () => {
    expect(commandMeaning("cat", words("a.ts")).reads).toEqual(words("a.ts"));
    expect(commandMeaning("rm", words("a.ts")).writes).toEqual([{ word: { kind: "literal", text: "a.ts" }, change: "delete" }]);
    expect(commandMeaning("touch", words("a.ts")).writes).toEqual([{ word: { kind: "literal", text: "a.ts" }, change: "create-if-missing" }]);
  });

  test("a command it does not know is taken to read its operands, and to write nothing", () => {
    expect(commandMeaning("frobnicate", words("a.ts"))).toMatchObject({ reads: words("a.ts"), lists: [], writes: [] });
  });
});

describe("read by bounded's shell command reader — commandMeaning: the small table of what a command does with its arguments", () => {
  test("a command it does not know reads every operand and every long option's value", () => {
    expect(commandMeaning("mytool", words("-v", "--config=c.json", "a", "--", "-b"))).toMatchObject({ reads: words("c.json", "a", "-b") });
  });
  test("text commands name nothing; ls with no operand lists where it runs", () => {
    expect(commandMeaning("echo", words(".env"))).toMatchObject({ reads: [], lists: [], writes: [] });
    expect(commandMeaning("ls", [])).toMatchObject({ lists: words(".") });
  });
  test("cd and pushd move, popd and an argument-less or dashed cd leave the place unknown", () => {
    expect(commandMeaning("cd", words("sub")).location).toEqual({ to: { kind: "literal", text: "sub" } });
    for (const [name, args] of [["cd", []], ["cd", words("-")], ["popd", []]] as const) expect(commandMeaning(name, [...args]).location).toEqual({ to: null });
  });
});
