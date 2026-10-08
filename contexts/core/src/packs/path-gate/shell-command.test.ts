import { describe, expect, test } from "bun:test";
import { describeShellCommand } from "./shell-command.ts";
import type { ShellToken } from "./shell-command.contract.ts";
import { shellQuoteParser } from "./shell-parser.shell-quote.ts";

const word = (text: string): ShellToken => ({ kind: "word", text });
const op = (operator: string): ShellToken => ({ kind: "operator", operator });

describe("describeShellCommand: a parsed command as the paths it reads and writes, deciding nothing", () => {
  test("arguments are reads, the command's name is not; `>` and `>>` targets are writes and `<` sources reads", () => {
    expect(describeShellCommand([word("sort"), word("a.txt"), op("<"), word("b.txt"), op(">"), word("out.txt"), op(";"), word("echo"), op(">>"), word("log.txt")], null)).toEqual({
      reads: ["a.txt", "b.txt"],
      writes: [
        { path: "out.txt", change: "create-or-modify" },
        { path: "log.txt", change: "create-or-modify" },
      ],
      unresolved: [],
    });
  });

  test("paths resolve from the directory given, and from a cd before them; ./ and quotes are gone already", () => {
    expect(describeShellCommand([word("cd"), word("sub"), op("&&"), word("cat"), word("../.env"), word("./x")], "app")).toEqual({ reads: ["app/.env", "app/sub/x"], writes: [], unresolved: [] });
  });

  test("an option's value is read; a bare option is not a path", () => {
    expect(describeShellCommand([word("node"), word("--env-file=.env"), word("-v"), word("app.js")], null)).toEqual({ reads: [".env", "app.js"], writes: [], unresolved: [] });
  });

  test("what only the shell can resolve is unresolved: the parser's unresolved tokens, variables, home, absolute paths and paths leaving the project", () => {
    expect(describeShellCommand([word("cat"), { kind: "unresolved", text: "*.env" }, word("$HOME/x"), word("~/x"), word("/etc/x"), word("../../x")], "a")).toEqual({
      reads: [],
      writes: [],
      unresolved: ["*.env", "$HOME/x", "~/x", "/etc/x", "../../x"],
    });
  });

  test("a file-descriptor duplication (2>&1) names no path", () => {
    expect(describeShellCommand([word("make"), word("2"), op(">&"), word("1")], null)).toEqual({ reads: [], writes: [], unresolved: [] });
  });
});

describe("shellQuoteParser: the shell parser behind the port", () => {
  test("gives words without quotes, operators, and globs as unresolved; drops comments", () => {
    expect(shellQuoteParser("cat './a b' \"c\" *.ts > out # note")).toEqual({
      ok: true,
      value: [word("cat"), word("./a b"), word("c"), { kind: "unresolved", text: "*.ts" }, op(">"), word("out")],
    });
  });

  test("keeps variables as written, so they stay unresolved", () => {
    expect(shellQuoteParser("cat $HOME/.env")).toEqual({ ok: true, value: [word("cat"), word("$HOME/.env")] });
  });

  test("a command it cannot read is an error, not a guess", () => {
    expect(shellQuoteParser("ls ${").ok).toBe(false);
  });
});
