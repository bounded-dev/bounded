import { describe, expect, test } from "bun:test";
import { Command } from "bounded/domain";
import type { ShellParser } from "./judge-calls.contract.ts";

const command = (text: string): Command => {
  const parsed = Command.parse(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

/** The behaviour every ShellParser must have: it refuses to parse until prepared, then parses synchronously into the port's syntax tree. */
export function shellParserConformance(name: string, fixture: () => Promise<ShellParser>): void {
  describe(`${name} conforms to ShellParser`, () => {
    test("parses nothing before it is prepared", async () => {
      expect((await fixture()).parse(command("ls")).ok).toBe(false);
    });

    test("once prepared, gives a command with its literal words and redirections", async () => {
      const parser = await fixture();
      await parser.prepare();
      const script = parser.parse(command("cat a.ts > b.ts"));
      expect(script.ok && script.value).toEqual([
        { kind: "command", name: { kind: "literal", text: "cat" }, args: [{ kind: "literal", text: "a.ts" }], redirects: [{ operator: ">", target: { kind: "literal", text: "b.ts" } }], assignments: [] },
      ]);
    });

    test("preparing twice is harmless", async () => {
      const parser = await fixture();
      await parser.prepare();
      await parser.prepare();
      expect(parser.parse(command("ls")).ok).toBe(true);
    });
  });
}
